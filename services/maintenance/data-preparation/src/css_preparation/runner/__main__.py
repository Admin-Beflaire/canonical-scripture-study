"""Run one Control-dispatched preparation job inside GitHub Actions.

Usage: python -m css_preparation.runner --kind {acquire,prepare,quality} --status FILE

The job arrives in the PREPARATION_JOB environment variable as Control's exact
canonical JSON bytes; it is never interpolated into a shell. Public output is limited
to the fixed status lines written to FILE. Detailed diagnostics go only into the
private result that Control records. Nothing here merges software, deploys,
approves scope or selects data.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Any, Mapping

from ..contracts import ContractError, job_result, parse_job_input
from ..executor import UnitNotRunnable, execute_unit
from ..executor.checkpoints import StopWork, UnitProgress, run_checkpointed_unit
from ..executor.quality import check_candidate_quality
from ..prepare.evidence import OutputBasis
from ..prepare.records import RecordError
from ..validate.saved import CandidateInventory
from .cloudflare import CloudflareConfig, CloudflareStorage
from .control import ControlClient, ControlConfig
from .recipes import RECIPES, Recipe
from .web import Origin, ProviderError

KINDS = ('acquire', 'prepare', 'quality')
_RUN_ID = re.compile(r'[1-9][0-9]{0,19}')
_COMMIT = re.compile(r'[0-9a-f]{40}')
REQUIRED = ('PREPARATION_JOB', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'CONTROL_ORIGIN', 'PREPARATION_ACCESS_CLIENT_ID',
            'PREPARATION_ACCESS_CLIENT_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'R2_BUCKET',
            'PREPARATION_CLOUDFLARE_TOKEN')


def _diagnostic(code: str, error: BaseException | None = None) -> list[dict[str, str]]:
    """Private detail for Control's record. Never printed to the public log."""
    message = code if error is None else f'{type(error).__name__}: {error}'
    return [{'code': code, 'message': message[:1000]}]


def _result(job: dict[str, Any], run_id: str, state: str, **fields: Any) -> dict[str, Any]:
    return job_result(job, run_id=run_id,
                      completed_extent=fields.get('completed_extent', {}),
                      remaining_extent=fields.get('remaining_extent', dict(job['native_extent'])),
                      output_refs=fields.get('output_refs', []), coverage_refs=fields.get('coverage_refs', []),
                      checkpoint_ref=fields.get('checkpoint_ref', job['checkpoint_ref']),
                      quality_receipt_ref=None, state=state, diagnostics=fields.get('diagnostics', []))


def _from_progress(job: dict[str, Any], run_id: str, progress: UnitProgress) -> dict[str, Any]:
    if progress.state == 'checkpointed' and progress.saved is not None and progress.remaining_extent == {}:
        return _result(job, run_id, 'succeeded', completed_extent=progress.completed_extent, remaining_extent={},
                       output_refs=list(progress.saved.artifact_refs), checkpoint_ref=progress.checkpoint_ref)
    code = progress.diagnostics[0] if progress.diagnostics else 'unit_failed'
    return _result(job, run_id, 'failed', diagnostics=_diagnostic(code))


def _inventory(job: dict[str, Any], storage: CloudflareStorage) -> CandidateInventory:
    """Control names the candidate's output IDs; exact bases come from the saved rows."""
    candidate = job['constraints'].get('candidate')
    if not isinstance(candidate, dict) or set(candidate) - {'added', 'reused', 'omitted'}:
        raise RecordError('Quality job needs constraints.candidate output IDs from Control')
    lists = {key: candidate.get(key, []) for key in ('added', 'reused', 'omitted')}
    if any(not isinstance(v, list) or any(not isinstance(i, str) for i in v) for v in lists.values()):
        raise RecordError('Candidate output IDs must be lists of strings')

    def basis(output_id: str) -> OutputBasis:
        row = storage.read_row('prepared_output', output_id)
        if row is None:
            raise RecordError('Candidate output is not saved')
        value = OutputBasis(row['kind'], tuple(row['input_revisions_json']), row['method_version'],
                            row['parameters_json'], row['native_extent_json'],
                            tuple(row['validation_basis_json']['dependencies']))
        if value.output_id != output_id:
            raise RecordError('Saved output identity does not match its basis')
        return value
    return CandidateInventory(added=tuple(basis(i) for i in lists['added']),
                              reused=tuple(basis(i) for i in lists['reused']),
                              omitted=tuple(lists['omitted']))


def run_job(job_json: str, kind: str, *, run_id: str, control: ControlClient, storage: CloudflareStorage,
            recipes: Mapping[str, Recipe] = RECIPES) -> dict[str, Any]:
    """Execute one job and return its result envelope (not yet submitted)."""
    job = parse_job_input(job_json)
    if job['kind'] != kind:
        raise ContractError('Workflow job does not match the dispatched kind')
    recipe = recipes.get(job['recipe_revision'])
    gate = dict(run_id=run_id, read_control=control.read_state, registered=storage.registered)
    try:
        if recipe is None:
            # Still confirm the dispatch, so a stale job is reported as not runnable.
            execute_unit(job_json, **gate, process=lambda _: None)
            return _result(job, run_id, 'failed', diagnostics=_diagnostic('no_registered_recipe'))
        if kind == 'quality':
            if recipe.read_source is None:
                return _result(job, run_id, 'failed', diagnostics=_diagnostic('no_registered_recipe'))
            return check_candidate_quality(
                job_json, **gate, inventory=_inventory(job, storage), read_rows=storage.read_rows,
                read_blob=storage.read_blob, read_source=lambda revision: recipe.read_source(revision, storage),
                receipts=storage.record_store('receipts'))
        module = getattr(recipe, kind)
        if module is None:
            return _result(job, run_id, 'failed', diagnostics=_diagnostic('no_registered_recipe'))

        def handler(entry: dict[str, Any]):
            return module(entry, storage)

        def refuse(_: dict[str, Any]):
            raise StopWork('refused')  # Only the dispatched kind may run in this workflow job.
        handlers = {k: (handler if k == kind else refuse) for k in KINDS}
        progress = run_checkpointed_unit(job_json, **gate, **handlers, storage=storage.candidate_store(),
                                         checkpoints=storage.record_store('checkpoints'))
        return _from_progress(job, run_id, progress)
    except UnitNotRunnable as error:
        return _result(job, run_id, 'cancelled', diagnostics=_diagnostic('not_runnable', error))
    except (RecordError, ProviderError, KeyError, ValueError, TypeError) as error:
        return _result(job, run_id, 'failed', diagnostics=_diagnostic('runner_failed', error))


PUBLIC = {
    'config': 'Preparation runner configuration incomplete; no work started.',
    'invalid': 'Preparation job input refused; no work started.',
    'undelivered': 'Preparation result could not be delivered to Control; Control reconciles this run.',
}


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    parser = argparse.ArgumentParser(prog='css_preparation.runner')
    parser.add_argument('--kind', choices=KINDS, required=True)
    parser.add_argument('--status', required=True)
    args = parser.parse_args(argv)
    lines: list[str] = []
    code = 1
    try:
        if any(not environ.get(name) for name in REQUIRED) or not _RUN_ID.fullmatch(environ['GITHUB_RUN_ID']) \
                or not _COMMIT.fullmatch(environ['GITHUB_SHA']):
            lines.append(PUBLIC['config'])
            return code
        try:
            control = ControlClient(ControlConfig(Origin(environ['CONTROL_ORIGIN']),
                                                  environ['PREPARATION_ACCESS_CLIENT_ID'],
                                                  environ['PREPARATION_ACCESS_CLIENT_SECRET']))
            storage = CloudflareStorage(CloudflareConfig(environ['CLOUDFLARE_ACCOUNT_ID'], environ['D1_DATABASE_ID'],
                                                         environ['R2_BUCKET'], environ['PREPARATION_CLOUDFLARE_TOKEN']))
        except ValueError:
            lines.append(PUBLIC['config'])
            return code
        try:
            result = run_job(environ['PREPARATION_JOB'], args.kind, run_id=environ['GITHUB_RUN_ID'],
                             control=control, storage=storage)
        except ContractError:
            lines.append(PUBLIC['invalid'])
            return code
        lines.append(f"Preparation {args.kind} unit finished: {result['state']}.")
        try:
            reply = control.submit_result(result, environ['GITHUB_SHA'])
        except (ProviderError, ValueError):
            lines.append(PUBLIC['undelivered'])
            return code
        lines.append(f"Control {reply['status']} the result.")
        code = 0 if result['state'] == 'succeeded' and reply['status'] in ('accepted', 'duplicate') else 1
        return code
    finally:
        with open(args.status, 'w', encoding='utf-8') as stream:
            stream.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], os.environ))

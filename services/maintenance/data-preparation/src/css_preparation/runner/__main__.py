"""Run one Control-dispatched preparation job inside GitHub Actions.

Usage: python -m css_preparation.runner --kind {acquire,prepare,quality} --status FILE
       python -m css_preparation.runner --validate --status FILE

The job is the `job` input of the workflow_dispatch event, read from the event file
(GITHUB_EVENT_PATH) as Control's exact canonical JSON text. It is never placed in a
step environment (GitHub prints those in public logs) or interpolated into a shell.
Configuration comes from masked environment secrets. Public output is limited to the
fixed status lines written to FILE. Detailed diagnostics go only into the
private result that Control records. Nothing here merges software, deploys,
approves scope or selects data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
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
REQUIRED = ('GITHUB_EVENT_PATH', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'CONTROL_ORIGIN', 'PREPARATION_ACCESS_CLIENT_ID',
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


def run_job(job_text: str, kind: str, *, run_id: str, control: ControlClient, storage: CloudflareStorage,
            recipes: Mapping[str, Recipe] = RECIPES) -> dict[str, Any]:
    """Execute one job and return its result envelope (not yet submitted)."""
    job_json = job_text
    job = parse_job_input(job_json)
    if job['kind'] != kind:
        raise ContractError('Workflow job does not match the dispatched kind')
    recipe = recipes.get(job['recipe_revision'])
    basis = hashlib.sha256(job_text.encode('utf-8')).hexdigest()

    def read_control(task_id: str, unit_id: str, attempt: int):
        return control.read_state(task_id, unit_id, attempt, run_id=run_id, job_input_basis=basis)
    gate = dict(run_id=run_id, read_control=read_control, registered=storage.registered)
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


def read_job(environ: Mapping[str, str]) -> str:
    """The dispatched job text, exactly as Control sent it."""
    try:
        with open(environ['GITHUB_EVENT_PATH'], encoding='utf-8') as stream:
            event = json.load(stream)
    except (KeyError, OSError, UnicodeError, ValueError):
        raise ContractError('Dispatch event is unreadable') from None
    job = event.get('inputs', {}).get('job') if isinstance(event, dict) and isinstance(event.get('inputs'), dict) else None
    if not isinstance(job, str):
        raise ContractError('Dispatch event has no job input')
    return job


PUBLIC = {
    'config': 'Preparation runner configuration incomplete; no work started.',
    'invalid': 'Preparation job input refused; no work started.',
    'undelivered': 'Preparation result could not be delivered to Control; Control reconciles this run.',
}


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    parser = argparse.ArgumentParser(prog='css_preparation.runner')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--kind', choices=KINDS)
    mode.add_argument('--validate', action='store_true')
    parser.add_argument('--status', required=True)
    args = parser.parse_args(argv)
    lines: list[str] = []
    code = 1
    try:
        if args.validate:
            # Route the run to one fixed job; only the enumerated kind leaves this step.
            try:
                kind = parse_job_input(read_job(environ))['kind']
            except (ContractError, ValueError):  # ValueError covers text that is not JSON
                lines.append(PUBLIC['invalid'])
                return code
            if kind not in KINDS or not environ.get('GITHUB_OUTPUT'):
                lines.append(PUBLIC['invalid'])
                return code
            with open(environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
                stream.write(f'kind={kind}\n')
            lines.append(f'Preparation job accepted for the {kind} job.')
            code = 0
            return code
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
            job_text = read_job(environ)
            job = parse_job_input(job_text)
            if job['kind'] != args.kind:
                raise ContractError('Workflow job does not match the dispatched kind')
        except (ContractError, ValueError):  # ValueError covers text that is not JSON
            lines.append(PUBLIC['invalid'])
            return code
        try:
            result = run_job(job_text, args.kind, run_id=environ['GITHUB_RUN_ID'], control=control, storage=storage)
        except Exception as error:  # noqa: BLE001 - unexpected: record privately, print nothing
            result = _result(job, environ['GITHUB_RUN_ID'], 'failed', diagnostics=_diagnostic('runner_error', error))
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

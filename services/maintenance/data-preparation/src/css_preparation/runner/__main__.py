"""Run one Control-dispatched preparation job inside GitHub Actions.

Usage: python -m css_preparation.runner --status FILE

The job is the `job` input of the workflow_dispatch event, read from the event file
(GITHUB_EVENT_PATH) as Control's exact canonical JSON text. It is never placed in a
step environment (GitHub prints those in public logs) or interpolated into a shell.
Configuration comes from masked environment secrets. Public output is limited to the
fixed status lines written to FILE and to one `::error` annotation per failure. The annotation
is the safe error record (`css_shared.error_record`), the same text that goes into the result
Control records. Nothing else is printed: a crash is reported as a record, never as a traceback.
Nothing here merges software, deploys, approves scope or selects data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from typing import Any, Mapping

from css_shared.error_record import annotation, error_record

from ..contracts import ContractError, parse_job_input, unit_result
from ..executor import InputNotRegisteredError, UnitNotRunnableError, execute_unit
from ..executor.unit import StopWorkError, UnitProgress, run_unit
from ..executor.quality import check_candidate_quality
from ..prepare.evidence import OutputBasis
from ..prepare.records import RecordError
from ..diagnostics import diagnostic, job_ids
from ..validate.saved import CandidateInventory
from .cloudflare import CloudflareConfig, CloudflareStorage
from .control import ControlClient, ControlConfig
from .recipes import RECIPES, Recipe, declared_input
from .web import Origin, ProviderError

KINDS = ("acquire", "prepare", "quality")
_RUN_ID = re.compile(r"[1-9][0-9]{0,19}")
_COMMIT = re.compile(r"[0-9a-f]{40}")
REQUIRED = (
    "GITHUB_EVENT_PATH",
    "GITHUB_RUN_ID",
    "GITHUB_SHA",
    "CONTROL_ORIGIN",
    "PREPARATION_ACCESS_CLIENT_ID",
    "PREPARATION_ACCESS_CLIENT_SECRET",
    "CLOUDFLARE_ACCOUNT_ID",
    "D1_DATABASE_ID",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "PREPARATION_CLOUDFLARE_TOKEN",
)


def _emit(record: Mapping[str, Any]) -> None:
    """Print one error record as a GitHub annotation; the assistants read it through the check-run API."""
    print(annotation(record), flush=True)


def _emit_failures(result: Mapping[str, Any]) -> None:
    """Annotate each failure diagnostic of a result; every message is a record built at the catch point."""
    for item in result["diagnostics"]:
        _emit(json.loads(item["message"]))


def _from_progress(
    job: dict[str, Any], run_id: str, progress: UnitProgress
) -> dict[str, Any]:
    if (
        progress.state == "saved"
        and progress.saved is not None
        and progress.remaining_extent == {}
    ):
        return unit_result(
            job,
            run_id,
            "succeeded",
            completed_extent=progress.completed_extent,
            remaining_extent={},
            output_refs=list(progress.saved.artifact_refs),
        )
    code = progress.diagnostics[0] if progress.diagnostics else "unit_failed"
    message = (
        progress.diagnostic_detail or diagnostic(job, "saving_unit", code)["message"]
    )
    return unit_result(
        job, run_id, "failed", diagnostics=[{"code": code, "message": message}]
    )


def _inventory(job: dict[str, Any], storage: CloudflareStorage) -> CandidateInventory:
    """Control names the candidate's output IDs; exact bases come from the saved rows."""
    candidate = job["constraints"].get("candidate")
    if not isinstance(candidate, dict) or set(candidate) - {
        "added",
        "reused",
        "omitted",
    }:
        raise RecordError(
            "Quality job needs constraints.candidate output IDs from Control"
        )
    lists = {key: candidate.get(key, []) for key in ("added", "reused", "omitted")}
    if any(
        not isinstance(v, list) or any(not isinstance(i, str) for i in v)
        for v in lists.values()
    ):
        raise RecordError("Candidate output IDs must be lists of strings")

    def basis(output_id: str) -> OutputBasis:
        row = storage.read_row("prepared_output", output_id)
        if row is None:
            raise RecordError("Candidate output is not saved")
        value = OutputBasis(
            row["kind"],
            tuple(row["input_revisions_json"]),
            row["method_version"],
            row["parameters_json"],
            row["native_extent_json"],
            tuple(row["validation_basis_json"]["dependencies"]),
        )
        if value.output_id != output_id:
            raise RecordError("Saved output identity does not match its basis")
        return value

    return CandidateInventory(
        added=tuple(basis(i) for i in lists["added"]),
        reused=tuple(basis(i) for i in lists["reused"]),
        omitted=tuple(lists["omitted"]),
    )


def run_job(
    job_text: str,
    kind: str,
    *,
    run_id: str,
    control: ControlClient,
    storage: CloudflareStorage,
    recipes: Mapping[str, Recipe] = RECIPES,
) -> dict[str, Any]:
    """Execute one job and return its result envelope (not yet submitted)."""
    job_json = job_text
    job = parse_job_input(job_json)
    if job["kind"] != kind:
        raise ContractError("Workflow job does not match the dispatched kind")
    recipe = recipes.get(job["recipe_revision"])
    basis = hashlib.sha256(job_text.encode("utf-8")).hexdigest()

    def read_control(task_id: str, unit_id: str, attempt: int):
        return control.read_state(
            task_id, unit_id, attempt, run_id=run_id, job_input_basis=basis
        )

    def registered(reference: dict[str, Any]) -> bool:
        return storage.registered(reference) or declared_input(
            reference, kind, recipe, recipes
        )

    gate = dict(run_id=run_id, read_control=read_control, registered=registered)
    try:
        if recipe is None:
            # Still confirm the dispatch, so a stale job is reported as not runnable.
            execute_unit(job_json, **gate, process=lambda _: None)
            return unit_result(
                job,
                run_id,
                "failed",
                diagnostics=[diagnostic(job, "recipe", "no_registered_recipe")],
            )
        if kind == "quality":
            if recipe.read_source is None:
                return unit_result(
                    job,
                    run_id,
                    "failed",
                    diagnostics=[diagnostic(job, "recipe", "no_registered_recipe")],
                )
            read_mappings = recipe.read_reader_references
            read_aids = recipe.read_aid_entries
            read_stated = recipe.read_statements
            return check_candidate_quality(
                job_json,
                **gate,
                inventory=_inventory(job, storage),
                read_rows=storage.read_rows,
                read_blob=storage.read_blob,
                read_source=lambda revision: recipe.read_source(revision, storage),
                receipts=storage.receipt_store(),
                read_reader_references=(lambda job: read_mappings(job, storage))
                if read_mappings
                else None,
                read_aid_entries=(lambda job: read_aids(job, storage))
                if read_aids
                else None,
                read_statements=(lambda job: read_stated(job, storage))
                if read_stated
                else None,
            )
        module = getattr(recipe, kind)
        if module is None:
            return unit_result(
                job,
                run_id,
                "failed",
                diagnostics=[diagnostic(job, "recipe", "no_registered_recipe")],
            )

        def handler(entry: dict[str, Any]):
            return module(entry, storage)

        def refuse(_: dict[str, Any]):
            raise StopWorkError(
                "refused"
            )  # Only the dispatched kind may run in this workflow job.

        handlers = {k: (handler if k == kind else refuse) for k in KINDS}
        progress = run_unit(
            job_json,
            **gate,
            **handlers,
            storage=storage.candidate_store(),
        )
        return _from_progress(job, run_id, progress)
    except UnitNotRunnableError as error:
        # An unregistered input is the task's own mistake: Control blocks at once instead of retrying.
        code = (
            "input_not_registered"
            if isinstance(error, InputNotRegisteredError)
            else "not_runnable"
        )
        return unit_result(
            job,
            run_id,
            "cancelled",
            diagnostics=[
                diagnostic(job, "control_check", code, error, outcome="cancelled")
            ],
        )
    except ProviderError as error:
        return unit_result(
            job,
            run_id,
            "failed",
            diagnostics=[diagnostic(job, "runner", "provider_failure", error)],
        )
    except (RecordError, KeyError, ValueError, TypeError) as error:
        return unit_result(
            job,
            run_id,
            "failed",
            diagnostics=[diagnostic(job, "runner", "runner_failed", error)],
        )


def read_job(environ: Mapping[str, str]) -> str:
    """The dispatched job text, exactly as Control sent it."""
    try:
        with open(environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
            event = json.load(stream)
    except (KeyError, OSError, UnicodeError, ValueError):
        raise ContractError("Dispatch event is unreadable") from None
    inputs = event.get("inputs") if isinstance(event, dict) else None
    job = inputs.get("job") if isinstance(inputs, dict) else None
    if not isinstance(job, str):
        raise ContractError("Dispatch event has no job input")
    # The run title GitHub recorded is built from dispatch_ref; it must name exactly these bytes.
    if inputs.get("dispatch_ref") != hashlib.sha256(job.encode("utf-8")).hexdigest():
        raise ContractError("Dispatch reference does not match the job")
    return job


PUBLIC = {
    "config": "Preparation runner configuration incomplete; no work started.",
    "invalid": "Preparation job input refused; no work started.",
    "undelivered": "Preparation result could not be delivered to Control; Control reconciles this run.",
}


def _refuse(
    lines: list[str],
    reason: str,
    stage: str,
    code: str,
    error: BaseException | None = None,
    **fields: Any,
) -> int:
    """Stop before any work: one public status line and one error record."""
    lines.append(PUBLIC[reason])
    _emit(error_record(error, tool="runner", stage=stage, code=code, **fields))
    return 1


def main(argv: list[str], environ: Mapping[str, str]) -> int:
    parser = argparse.ArgumentParser(prog="css_preparation.runner")
    parser.add_argument("--status", required=True)
    args = parser.parse_args(argv)
    lines: list[str] = []
    try:
        missing = [name for name in REQUIRED if not environ.get(name)]
        if (
            missing
            or not _RUN_ID.fullmatch(environ.get("GITHUB_RUN_ID", ""))
            or not _COMMIT.fullmatch(environ.get("GITHUB_SHA", ""))
        ):
            return _refuse(
                lines,
                "config",
                "configuration",
                "config_incomplete",
                counts={"missing": len(missing)},
            )
        try:
            job_text = read_job(environ)
            job = parse_job_input(job_text)
        except (
            ContractError,
            ValueError,
        ) as error:  # ValueError covers text that is not JSON
            return _refuse(lines, "invalid", "job_input", "invalid_job", error)
        kind = job["kind"]
        if kind not in KINDS:
            return _refuse(lines, "invalid", "job_input", "unknown_kind")
        try:
            control = ControlClient(
                ControlConfig(
                    Origin(environ["CONTROL_ORIGIN"]),
                    environ["PREPARATION_ACCESS_CLIENT_ID"],
                    environ["PREPARATION_ACCESS_CLIENT_SECRET"],
                )
            )
            storage = CloudflareStorage(
                CloudflareConfig(
                    environ["CLOUDFLARE_ACCOUNT_ID"],
                    environ["D1_DATABASE_ID"],
                    environ["R2_BUCKET"],
                    environ["PREPARATION_CLOUDFLARE_TOKEN"],
                    environ["R2_ACCESS_KEY_ID"],
                )
            )
        except ValueError as error:
            return _refuse(lines, "config", "configuration", "config_invalid", error)
        run_id = environ["GITHUB_RUN_ID"]
        try:
            result = run_job(
                job_text, kind, run_id=run_id, control=control, storage=storage
            )
        except Exception as error:
            result = unit_result(
                job,
                run_id,
                "failed",
                diagnostics=[diagnostic(job, "runner", "runner_error", error)],
            )
        _emit_failures(result)
        lines.append(f"Preparation {kind} unit finished: {result['state']}.")
        try:
            reply = control.submit_result(result, environ["GITHUB_SHA"])
        except (ProviderError, ValueError) as error:
            _emit(
                error_record(
                    error,
                    tool=kind,
                    stage="submitting_result",
                    code="undelivered",
                    ids=job_ids(job),
                )
            )
            lines.append(PUBLIC["undelivered"])
            return 1
        lines.append(f"Control {reply['status']} the result.")
        return (
            0
            if result["state"] == "succeeded"
            and reply["status"] in ("accepted", "duplicate")
            else 1
        )
    finally:
        with open(args.status, "w", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")


def run() -> int:
    """Command entry point. Whatever happens, only error records are printed, never a traceback."""
    try:
        return main(sys.argv[1:], os.environ)
    except SystemExit:
        raise
    except BaseException as error:
        _emit(
            error_record(error, tool="runner", stage="startup", code="runner_crashed")
        )
        return 1


if __name__ == "__main__":
    sys.exit(run())

"""Run one preparation unit with a bounded retry around the existing executor.

No workflow transport or promotion: the runner injects candidate storage and
Control's read-only gate. A unit keeps nothing between attempts except its saved
candidate outputs; a failed unit reruns as a new attempt. A saved unit is not a
quality receipt.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Callable

from ..contracts import parse_job_input
from ..prepare.records import ReaderBoundaryError, RecordError, RecordSet
from ..diagnostics import diagnostic
from ..provider import ProviderError
from . import ControlState, UnitNotRunnable, execute_unit
from .candidate import CandidateStore, SavedCandidate, persist_candidate
from .basis import check_unit_records
from ..prepare.evidence import OutputBasis
from ..validate.saved import CandidateInventory, verify_candidate_inventory


@dataclass(frozen=True)
class UnitProgress:
    """Internal progress only; the quality step owns the versioned result receipt."""

    state: str  # saved | failed
    completed_extent: dict[str, Any]
    remaining_extent: dict[str, Any]
    saved: SavedCandidate | None
    diagnostics: tuple[str, ...] = ()
    diagnostic_detail: str | None = None


class RetryableUnitError(Exception):
    """An explicitly classified transient failure; no unbounded retry."""


class StopWorkError(Exception):
    """Classified quota, refusal, dependency or limit failure (no private detail)."""

    def __init__(self, reason: str):
        if reason not in ("quota", "refused", "missing_dependency", "limit"):
            raise ValueError("Unsupported stop reason")
        self.reason = reason
        super().__init__(reason)


_RETRYABLE = (RetryableUnitError, TimeoutError, ConnectionError)
# Checked in this order: the first class an error belongs to names its failure.
_STOPS = (
    (ReaderBoundaryError, "reader_boundary"),
    (ProviderError, "provider_failure"),
    ((RecordError, OSError), "invalid_or_unavailable_output"),
)


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _outputs_saved(outputs: list[str], storage: CandidateStore) -> bool:
    for output_id in outputs:
        row = storage.optional_row("prepared_output", output_id)
        if row is None or row.get("id") != output_id:
            return False
    return True


def _artifact_intact(
    reference: dict[str, Any], outputs: list[str], storage: CandidateStore
) -> bool:
    """One saved artifact still has the registered row and the exact bytes."""
    row = storage.read_row("artifact", reference["artifact_id"])
    if (
        row is None
        or row.get("id") != reference["artifact_id"]
        or row.get("sha256") != reference["sha256"]
        or row.get("byte_count") != reference["byte_count"]
        or row.get("output_id") not in outputs
    ):
        return False
    try:
        data = storage.read_blob(row["registered_locator"])
    except (KeyError, OSError):
        return False
    return (
        isinstance(data, bytes)
        and len(data) == reference["byte_count"]
        and _digest(data) == reference["sha256"]
    )


def _output_bases(
    outputs: list[str], storage: CandidateStore
) -> dict[str, OutputBasis] | None:
    """The unit's outputs with their saved transitive output dependencies.

    Index units commonly depend on an evidence output produced by another unit.
    Omitting that parent from the inventory would falsely reject the unit.
    """
    bases_by_id: dict[str, OutputBasis] = {}
    pending = list(outputs)
    while pending:
        current = pending.pop(0)
        if current in bases_by_id:
            continue
        row = storage.read_row("prepared_output", current)
        try:
            basis = OutputBasis(
                row["kind"],
                tuple(row["input_revisions_json"]),
                row["method_version"],
                row["parameters_json"],
                row["native_extent_json"],
                tuple(row["validation_basis_json"]["dependencies"]),
            )
        except (KeyError, TypeError, ValueError):
            return None
        if basis.output_id != current:
            return None
        bases_by_id[current] = basis
        pending.extend(basis.dependencies)
    return bases_by_id


def _inventory_matches(
    saved: SavedCandidate,
    bases_by_id: dict[str, OutputBasis],
    storage: CandidateStore,
) -> bool:
    outputs = list(saved.output_ids)
    try:
        verified = verify_candidate_inventory(
            CandidateInventory(
                added=tuple(bases_by_id[key] for key in outputs),
                reused=tuple(b for key, b in bases_by_id.items() if key not in outputs),
            ),
            read_rows=storage.read_rows,
            read_blob=storage.read_blob,
        )
    except RecordError:
        return False
    current_refs = {
        (row["id"], row["sha256"], row["byte_count"])
        for row in storage.read_rows("artifact", outputs)
        if row.get("output_id") in outputs
    }
    expected_refs = {
        (ref["artifact_id"], ref["sha256"], ref["byte_count"])
        for ref in saved.artifact_refs
    }
    return (
        tuple(verified.output_ids[: len(outputs)]) == tuple(outputs)
        and current_refs == expected_refs
    )


def _candidate_intact(saved: SavedCandidate, storage: CandidateStore) -> bool:
    """Do the saved identities still match their registered bytes and rows?"""
    outputs = list(saved.output_ids)
    if len(set(outputs)) != len(outputs) or not _outputs_saved(outputs, storage):
        return False
    if not all(_artifact_intact(ref, outputs, storage) for ref in saved.artifact_refs):
        return False
    if storage.read_rows is None:
        return False  # Without saved scoped rows, integrity cannot be verified.
    bases_by_id = _output_bases(outputs, storage)
    return bases_by_id is not None and _inventory_matches(saved, bases_by_id, storage)


def run_unit(
    job_json: str,
    *,
    run_id: str,
    read_control: Callable[[str, str, int], ControlState | None],
    registered: Callable[[dict[str, Any]], bool],
    acquire: Callable[[dict[str, Any]], RecordSet],
    prepare: Callable[[dict[str, Any]], RecordSet],
    quality: Callable[[dict[str, Any]], RecordSet],
    storage: CandidateStore,
    max_retries: int = 1,
) -> UnitProgress:
    """Check Control before each attempt; preserve saved units on pause/cancel.

    A job envelope describes one bounded unit. The scheduler dispatches further
    units separately. Failures never claim completed coverage or promotion.
    """
    if type(max_retries) is not int or not 0 <= max_retries <= 3:
        raise ValueError("Retry limit must be between zero and three")
    job = parse_job_input(job_json)
    handlers = {"acquire": acquire, "prepare": prepare, "quality": quality}

    stage = "control_check"

    def failure(code: str, error: BaseException | None = None) -> UnitProgress:
        return UnitProgress(
            "failed",
            {},
            dict(job["native_extent"]),
            None,
            (code,),
            diagnostic(job, stage, code, error)["message"],
        )

    def process(entry: dict[str, Any]) -> UnitProgress:
        nonlocal stage
        stage = "acquiring_input" if entry["kind"] == "acquire" else "building_output"
        records = handlers[entry["kind"]](entry)
        stage = "validating_output"
        check_unit_records(entry, records, storage)
        # If a long-running builder finished after pause/cancel/supersession,
        # do not begin candidate writes. Control owns late-result acceptance.
        stage = "control_check"
        execute_unit(
            job_json,
            run_id=run_id,
            read_control=read_control,
            registered=registered,
            process=lambda _: None,
        )
        stage = "saving_output"
        saved = persist_candidate(records, storage)
        stage = "verifying_output"
        if (
            storage.read_rows is not None
            and saved.output_ids
            and not _candidate_intact(saved, storage)
        ):
            raise RecordError("Saved candidate is incomplete")
        return UnitProgress("saved", dict(entry["native_extent"]), {}, saved)

    for retry in range(max_retries + 1):
        try:
            stage = "control_check"
            return execute_unit(
                job_json,
                run_id=run_id,
                read_control=read_control,
                registered=registered,
                process=process,
            )
        except UnitNotRunnable:
            if retry == 0:
                raise  # Refused before any unit work.
            return failure("stopped")
        except StopWorkError as error:
            return failure(error.reason)
        except _RETRYABLE as error:
            if retry == max_retries:
                return failure("transient_exhausted", error)
        except (ReaderBoundaryError, ProviderError, RecordError, OSError) as error:
            code = next(code for kinds, code in _STOPS if isinstance(error, kinds))
            return failure(code, error)
    raise AssertionError("Unreachable retry loop")

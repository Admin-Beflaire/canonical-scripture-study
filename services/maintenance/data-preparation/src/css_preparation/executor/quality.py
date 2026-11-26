"""Save exact candidate-quality receipts and return the existing Control job result."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Callable, Sequence

from ..indexes.files import PAGE_CAP
from ..contracts import parse_job_input, unit_result
from ..prepare.evidence import NativeText
from ..prepare.records import ReaderBoundaryError, RecordError
from ..diagnostics import diagnostic
from ..provider import ProviderError
from ..validate.saved import CandidateInventory
from ..validate.semantic import Rebuild, _canonical, check_saved_semantics
from . import ControlState, UnitNotRunnableError, execute_unit
from .records import RecordStore, check_record_ref

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")


def check_candidate_quality(
    job_json: str,
    *,
    run_id: str,
    read_control: Callable[[str, str, int], ControlState | None],
    registered: Callable[[dict[str, Any]], bool],
    inventory: CandidateInventory,
    read_rows: Callable[[str, Sequence[str]], list[dict[str, Any]]],
    read_blob: Callable[[str], bytes],
    read_source: Callable[[str], NativeText],
    receipts: RecordStore,
    max_page_bytes: int = PAGE_CAP,
    read_reader_references: Rebuild = None,
    read_aid_entries: Rebuild = None,
    read_statements: Rebuild = None,
) -> dict[str, Any]:
    """Read-only candidate check; Control alone checks scope and promotes data."""
    job = parse_job_input(job_json)
    if job["kind"] != "quality":
        raise RecordError("Only quality jobs may issue candidate-wide receipts")

    def result(state: str, **fields: Any) -> dict[str, Any]:
        return unit_result(job, run_id, state, **fields)

    def failed(stage: str, code: str, error: BaseException) -> dict[str, Any]:
        return result("failed", diagnostics=[diagnostic(job, stage, code, error)])

    def process(entry: dict[str, Any]) -> dict[str, Any]:
        stage = "validating_candidate"
        try:
            if not entry["required_capabilities"]:
                raise RecordError("Quality job must require at least one capability")
            evidence = check_saved_semantics(
                entry,
                inventory,
                read_rows=read_rows,
                read_blob=read_blob,
                read_source=read_source,
                max_page_bytes=max_page_bytes,
                read_reader_references=read_reader_references,
                read_aid_entries=read_aid_entries,
                read_statements=read_statements,
            )
            if len(evidence.saved.artifact_refs) > 256 or len(evidence.coverage) > 256:
                raise RecordError("Candidate exceeds result reference limits")
            # The coverage identifier is the digest of the saved D1 composite
            # identity; its exact row and basis are included in the receipt.
            coverage_refs = [
                "coverage:"
                + hashlib.sha256(
                    _canonical(
                        {
                            key: row[key]
                            for key in ("output_id", "source_revision_id", "capability")
                        }
                    )
                ).hexdigest()[:32]
                for row in evidence.coverage
            ]
            receipt = {
                "contract_version": "preparation-quality/1",
                "task": {
                    key: entry[key]
                    for key in (
                        "task_id",
                        "task_revision",
                        "unit_id",
                        "attempt",
                        "basis_digest",
                        "manifest_revision",
                        "recipe_revision",
                        "native_extent",
                        "required_capabilities",
                        "input_refs",
                        "dependency_refs",
                    )
                },
                "job_input_sha256": hashlib.sha256(
                    job_json.encode("utf-8")
                ).hexdigest(),
                "run_id": run_id,
                "candidate": {
                    "added": [b.row() for b in inventory.added],
                    "reused": [b.row() for b in inventory.reused],
                    "omitted": list(inventory.omitted),
                    "output_ids": list(evidence.saved.output_ids),
                    "artifact_refs": list(evidence.saved.artifact_refs),
                },
                "coverage": list(evidence.coverage),
                "coverage_refs": coverage_refs,
                "actual_capabilities": list(evidence.capabilities),
                "checks": [
                    "saved_inventory",
                    "artifact_digest",
                    "source_fidelity",
                    "native_coordinates",
                    "index_postings",
                    "relationship_endpoints",
                    "required_coverage",
                    *(
                        ["reader_references"]
                        if read_reader_references is not None
                        else []
                    ),
                    *(["aid_entries"] if read_aid_entries is not None else []),
                    *(["statements"] if read_statements is not None else []),
                ],
                "limitations": list(evidence.limitations),
                "passed": True,
            }
            data = _canonical(receipt)
            # State can change during quality; do not issue a receipt for a
            # cancelled/superseded task. Control also rejects late results.
            stage = "control_check"
            execute_unit(
                job_json,
                run_id=run_id,
                read_control=read_control,
                registered=registered,
                process=lambda _: None,
            )
            stage = "saving_receipt"
            reference = receipts.save(data)
            stage = "verifying_receipt"
            check_record_ref(reference, receipts.load(reference))
            if receipts.load(reference) != data:
                raise RecordError("Saved quality receipt bytes differ")
            return result(
                "succeeded",
                completed_extent=dict(entry["native_extent"]),
                remaining_extent={},
                output_refs=list(evidence.saved.artifact_refs),
                coverage_refs=coverage_refs,
                quality_receipt_ref=reference,
            )
        except UnitNotRunnableError:
            raise  # A late cancellation is not a failed quality check.
        except ReaderBoundaryError as error:
            return failed(stage, "reader_boundary", error)
        except ProviderError as error:
            return failed(stage, "provider_failure", error)
        except (RecordError, KeyError, ValueError, UnicodeError, OSError) as error:
            return failed(stage, "quality_failed", error)

    try:
        return execute_unit(
            job_json,
            run_id=run_id,
            read_control=read_control,
            registered=registered,
            process=process,
        )
    except ProviderError as error:
        return failed("control_check", "provider_failure", error)
    except OSError as error:
        return failed("control_check", "quality_failed", error)

"""Persist one bounded candidate unit from the existing Preparation modules.

D1 candidate-row writes are transactional; immutable private-R2 bytes must be
read back before their registry rows can be acknowledged. No release writes,
selection, provider setup, or Control scope decision is made here.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Callable, Mapping, Sequence

from ..prepare.records import KEYS, RecordError, RecordSet, comparable


@dataclass(frozen=True)
class CandidateStore:
    """Small storage boundary supplied by the runner (synthetic stand-in in tests).

    put_blob must refuse replacing different bytes at an existing immutable key;
    write_rows must commit the complete SQL statement list atomically.
    """

    put_blob: Callable[[str, bytes], None]
    read_blob: Callable[[str], bytes]
    write_rows: Callable[[list[tuple[str, list[Any]]]], None]
    read_row: Callable[[str, str], Mapping[str, Any] | None]
    read_rows: Callable[[str, Sequence[str]], list[dict[str, Any]]] | None = (
        None  # (kind, output IDs)
    )

    def optional_row(self, kind: str, identity: str) -> Mapping[str, Any] | None:
        """Missing D1 identity is None; tolerate KeyError-style adapters safely."""
        try:
            return self.read_row(kind, identity)
        except KeyError:
            return None


@dataclass(frozen=True)
class SavedCandidate:
    """Verified saved output identities; not a quality or scope receipt."""

    output_ids: tuple[str, ...]
    artifact_refs: tuple[dict[str, Any], ...]


def _check_saved_rows(
    records: RecordSet, output_id: str, storage: CandidateStore
) -> None:
    """A saved output is reused only if every row it owns equals the candidate's.

    The output basis does not cover its owned rows (spans, segments, annotations,
    relationships, coverage), so they are compared directly.
    """
    if storage.read_rows is None:
        raise RecordError("Cannot verify a saved output without its saved rows")
    for kind, rows in records.owned_rows(output_id).items():
        if kind == "prepared_output":
            continue
        expected = sorted(
            (comparable(kind, row) for row in rows),
            key=lambda r: tuple(r[k] for k in KEYS[kind]),
        )
        saved = sorted(
            (
                comparable(kind, dict(row))
                for row in storage.read_rows(kind, [output_id])
            ),
            key=lambda r: tuple(r[k] for k in KEYS[kind]),
        )
        if saved != expected:
            raise RecordError("Existing candidate metadata is incomplete or different")


def _check_candidate(records: RecordSet) -> None:
    """Every artifact belongs to an output and its bytes match its registration."""
    if not isinstance(records, RecordSet):
        raise RecordError("Preparation module must return a RecordSet")
    output_ids = {item["id"] for item in records.rows("prepared_output")}
    artifacts = records.rows("artifact")
    if set(records.blobs) != {item["id"] for item in artifacts}:
        raise RecordError("Every new artifact must have saved bytes and metadata")
    for artifact in artifacts:
        if artifact["output_id"] not in output_ids:
            raise RecordError("Artifact output not present in the candidate unit")
        data = records.blobs[artifact["id"]]
        if (
            len(data) != artifact["byte_count"]
            or hashlib.sha256(data).hexdigest() != artifact["sha256"]
        ):
            raise RecordError(
                "Artifact byte count or digest does not match registered metadata"
            )


def _save_blobs(records: RecordSet, storage: CandidateStore) -> None:
    for artifact in records.rows("artifact"):
        locator = artifact["registered_locator"]
        storage.put_blob(locator, records.blobs[artifact["id"]])
        saved = storage.read_blob(locator)
        if not isinstance(saved, bytes) or saved != records.blobs[artifact["id"]]:
            raise RecordError("Saved artifact bytes differ from the candidate")


def _saved_outputs(records: RecordSet, storage: CandidateStore) -> list[str]:
    """IDs of outputs already saved exactly as the candidate describes them.

    An output may already be saved: by a retry after a saved candidate but before its
    report, or by an earlier build when its basis is unchanged (a rebuild that
    reuses evidence and adds new indexes). Each saved output, with its artifacts, must be
    exactly the candidate's. Never overwrite identities.
    """
    artifacts = records.rows("artifact")
    reused = []
    for output in records.rows("prepared_output"):
        owned = [row for row in artifacts if row["output_id"] == output["id"]]
        saved_output = storage.optional_row("prepared_output", output["id"])
        saved_owned = [storage.optional_row("artifact", row["id"]) for row in owned]
        if saved_output is None and all(row is None for row in saved_owned):
            continue
        if saved_output != output or saved_owned != owned:
            raise RecordError("Existing candidate metadata is incomplete or different")
        _check_saved_rows(records, output["id"], storage)
        reused.append(output["id"])
    return reused


def persist_candidate(records: RecordSet, storage: CandidateStore) -> SavedCandidate:
    """Save immutable blobs before candidate records and report only read-back refs.

    An interrupted row commit may leave an unreferenced immutable blob. It must
    never produce a successful result; the quality step reconciles it.
    """
    _check_candidate(records)
    outputs = records.rows("prepared_output")
    artifacts = records.rows("artifact")
    _save_blobs(records, storage)
    # The remaining outputs are written in one atomic batch.
    reused = _saved_outputs(records, storage)
    if not outputs or len(reused) < len(outputs):
        storage.write_rows(records.without_outputs(reused).statements())
    for output in outputs:
        if storage.read_row("prepared_output", output["id"]) != output:
            raise RecordError("Saved candidate output identity differs")
    for artifact in artifacts:
        if storage.read_row("artifact", artifact["id"]) != artifact:
            raise RecordError("Saved artifact registration differs")

    return SavedCandidate(
        tuple(item["id"] for item in outputs),
        tuple(
            {
                "artifact_id": item["id"],
                "sha256": item["sha256"],
                "byte_count": item["byte_count"],
            }
            for item in artifacts
        ),
    )

"""Persist one bounded candidate unit from the existing Preparation modules.

D1 candidate-row writes are transactional; immutable private-R2 bytes must be
read back before their registry rows can be acknowledged. No release writes,
selection, provider setup, or Control scope decision is made here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Callable, Mapping

from ..prepare.records import RecordError, RecordSet
from . import ControlState, execute_unit


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


@dataclass(frozen=True)
class SavedCandidate:
    """Verified saved output identities; not a quality or scope receipt."""

    output_ids: tuple[str, ...]
    artifact_refs: tuple[dict[str, Any], ...]


def persist_candidate(records: RecordSet, storage: CandidateStore) -> SavedCandidate:
    """Save immutable blobs before candidate records and report only read-back refs.

    An interrupted row commit may leave an unreferenced immutable blob. It must
    never produce a successful result; later checkpoint/quality stages reconcile it.
    """
    if not isinstance(records, RecordSet):
        raise RecordError('Preparation module must return a RecordSet')
    outputs = records.rows('prepared_output')
    artifacts = records.rows('artifact')
    output_ids = {item['id'] for item in outputs}
    metadata = {item['id']: item for item in artifacts}
    if set(records.blobs) != set(metadata):
        raise RecordError('Every new artifact must have saved bytes and metadata')
    for artifact in artifacts:
        if artifact['output_id'] not in output_ids:
            raise RecordError('Artifact output not present in the candidate unit')
        data = records.blobs[artifact['id']]
        if (len(data) != artifact['byte_count'] or
                hashlib.sha256(data).hexdigest() != artifact['sha256']):
            raise RecordError('Artifact byte count or digest does not match registered metadata')

    for artifact in artifacts:
        locator = artifact['registered_locator']
        storage.put_blob(locator, records.blobs[artifact['id']])
        saved = storage.read_blob(locator)
        if (not isinstance(saved, bytes) or saved != records.blobs[artifact['id']]):
            raise RecordError('Saved artifact bytes differ from the candidate')

    storage.write_rows(records.statements())
    for output in outputs:
        if storage.read_row('prepared_output', output['id']) != output:
            raise RecordError('Saved candidate output identity differs')
    for artifact in artifacts:
        if storage.read_row('artifact', artifact['id']) != artifact:
            raise RecordError('Saved artifact registration differs')

    return SavedCandidate(tuple(item['id'] for item in outputs), tuple({
        'artifact_id': item['id'], 'sha256': item['sha256'], 'byte_count': item['byte_count']
    } for item in artifacts))


def run_candidate_unit(job_json: str, *, run_id: str,
                       read_control: Callable[[str, str, int], ControlState | None],
                       registered: Callable[[dict[str, Any]], bool],
                       acquire: Callable[[dict[str, Any]], RecordSet],
                       prepare: Callable[[dict[str, Any]], RecordSet],
                       quality: Callable[[dict[str, Any]], RecordSet],
                       storage: CandidateStore) -> SavedCandidate:
    """Use the Stage 1 gate, then call only the requested module and save its rows.

    Handlers bind the existing acquisition, preparation/index or validation
    functions for an explicitly instructed unit. Quality results and durable
    checkpoints are intentionally not claimed by this Stage 2 entry.
    """
    handlers = {'acquire': acquire, 'prepare': prepare, 'quality': quality}

    def run(job: dict[str, Any]) -> SavedCandidate:
        return persist_candidate(handlers[job['kind']](job), storage)

    return execute_unit(job_json, run_id=run_id, read_control=read_control,
                        registered=registered, process=run)

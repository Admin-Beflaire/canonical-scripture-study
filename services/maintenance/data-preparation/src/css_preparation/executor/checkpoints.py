"""Durable one-unit checkpoint and bounded retry around the existing executor.

No workflow transport or promotion: the runner injects immutable checkpoint
storage and Control's read-only gate. A saved unit is not a quality receipt.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Callable

from ..contracts import parse_job_input
from ..prepare.records import ReaderBoundaryError, RecordError, RecordSet
from ..provider import ProviderError, provider_diagnostic, stage_diagnostic
from . import ControlState, UnitNotRunnable, execute_unit
from .candidate import CandidateStore, SavedCandidate, persist_candidate
from .basis import check_unit_records, check_output_basis, registered_dependency_outputs
from ..prepare.evidence import OutputBasis
from ..validate.saved import CandidateInventory, verify_candidate_inventory

_FORMAT = 'preparation-checkpoint/1'
_REF_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}')


@dataclass(frozen=True)
class CheckpointStore:
    """Save registers an immutable artifact; load returns its exact saved bytes."""

    save: Callable[[bytes], dict[str, Any]]
    load: Callable[[dict[str, Any]], bytes]


@dataclass(frozen=True)
class UnitProgress:
    """Internal progress only; Stage 5 owns the versioned result/quality receipt."""

    state: str                     # checkpointed | failed
    completed_extent: dict[str, Any]
    remaining_extent: dict[str, Any]
    cursor: str | None
    saved: SavedCandidate | None
    checkpoint_ref: dict[str, Any] | None
    diagnostics: tuple[str, ...] = ()
    diagnostic_detail: str | None = None


class RetryableUnitError(Exception):
    """An explicitly classified transient failure; no unbounded retry."""


class StopWork(Exception):
    """Classified quota, refusal, dependency or limit failure (no private detail)."""

    def __init__(self, reason: str):
        if reason not in ('quota', 'refused', 'missing_dependency', 'limit'):
            raise ValueError('Unsupported stop reason')
        self.reason = reason
        super().__init__(reason)


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _identity(job: dict[str, Any]) -> dict[str, Any]:
    # The checkpoint pointer changes on resume; the other job fields must not.
    return {key: value for key, value in job.items() if key != 'checkpoint_ref'}


def _bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(',', ':')).encode('utf-8')


def _check_ref(reference: Any, data: bytes) -> None:
    if (not isinstance(data, bytes) or not isinstance(reference, dict)
            or set(reference) != {'artifact_id', 'sha256', 'byte_count'}
            or not isinstance(reference['artifact_id'], str)
            or not _REF_ID.fullmatch(reference['artifact_id'])
            or reference['sha256'] != _digest(data)
            or type(reference['byte_count']) is not int or reference['byte_count'] != len(data)):
        raise RecordError('Checkpoint artifact identity or bytes do not match')


def _saved_candidate(value: Any, storage: CandidateStore) -> SavedCandidate | None:
    """Reuse only saved candidate identities whose registered bytes still match."""
    if not isinstance(value, dict) or set(value) != {'output_ids', 'artifact_refs'}:
        return None
    outputs, references = value['output_ids'], value['artifact_refs']
    if (not isinstance(outputs, list) or not isinstance(references, list)
            or any(not isinstance(item, str) for item in outputs)
            or len(set(outputs)) != len(outputs)):
        return None
    for output_id in outputs:
        row = storage.optional_row('prepared_output', output_id)
        if row is None or row.get('id') != output_id:
            return None
    for reference in references:
        if not isinstance(reference, dict) or set(reference) != {'artifact_id', 'sha256', 'byte_count'}:
            return None
        row = storage.read_row('artifact', reference['artifact_id'])
        if (row is None or row.get('id') != reference['artifact_id']
                or row.get('sha256') != reference['sha256']
                or row.get('byte_count') != reference['byte_count']
                or row.get('output_id') not in outputs):
            return None
        try:
            data = storage.read_blob(row['registered_locator'])
        except (KeyError, OSError):
            return None
        if (not isinstance(data, bytes) or len(data) != reference['byte_count']
                or _digest(data) != reference['sha256']):
            return None
    if storage.read_rows is None:
        return None  # Without saved scoped rows, replay cannot verify integrity.
    # Verify this unit together with the saved transitive output dependencies.
    # Index units commonly depend on an evidence output produced by another
    # unit. Omitting that parent from inventory would falsely reject replay.
    bases_by_id = {}
    pending = list(outputs)
    while pending:
        current = pending.pop(0)
        if current in bases_by_id:
            continue
        row = storage.read_row('prepared_output', current)
        try:
            basis = OutputBasis(row['kind'], tuple(row['input_revisions_json']),
                                row['method_version'], row['parameters_json'],
                                row['native_extent_json'],
                                tuple(row['validation_basis_json']['dependencies']))
        except (KeyError, TypeError, ValueError):
            return None
        if basis.output_id != current:
            return None
        bases_by_id[current] = basis
        pending.extend(basis.dependencies)
    try:
        verified = verify_candidate_inventory(
            CandidateInventory(added=tuple(bases_by_id[key] for key in outputs),
                               reused=tuple(b for key, b in bases_by_id.items()
                                            if key not in outputs)),
            read_rows=storage.read_rows, read_blob=storage.read_blob)
    except RecordError:
        return None
    current_refs = {
        (row['id'], row['sha256'], row['byte_count'])
        for row in storage.read_rows('artifact', outputs) if row.get('output_id') in outputs
    }
    expected_refs = {(ref['artifact_id'], ref['sha256'], ref['byte_count'])
                     for ref in references}
    if (tuple(verified.output_ids[:len(outputs)]) != tuple(outputs)
            or current_refs != expected_refs):
        return None
    return SavedCandidate(tuple(outputs), tuple(dict(ref) for ref in references))


def _resume(job: dict[str, Any], storage: CandidateStore,
            checkpoints: CheckpointStore) -> UnitProgress | None:
    reference = job['checkpoint_ref']
    if reference is None:
        return None
    try:
        data = checkpoints.load(reference)
    except (KeyError, OSError):
        return None  # Missing saved checkpoint means this unit still needs work.
    _check_ref(reference, data)
    try:
        record = json.loads(data)
    except (UnicodeError, ValueError) as error:
        raise RecordError('Checkpoint content is not valid JSON') from error
    if (not isinstance(record, dict) or record.get('format_version') != _FORMAT
            or record.get('identity') != _identity(job)):
        # Incompatible basis, task, attempt or method: rebuild, do not mix revisions.
        return None
    if (record.get('completed_extent') != job['native_extent']
            or record.get('remaining_extent') != {}
            or record.get('cursor') != job['unit_id']):
        return None
    saved = _saved_candidate(record.get('saved'), storage)
    if saved is None:
        return None
    return UnitProgress('checkpointed', dict(job['native_extent']), {}, job['unit_id'],
                        saved, dict(reference))


def _save(job: dict[str, Any], saved: SavedCandidate,
          checkpoints: CheckpointStore) -> UnitProgress:
    record = {
        'format_version': _FORMAT, 'identity': _identity(job),
        'completed_extent': job['native_extent'], 'remaining_extent': {},
        'cursor': job['unit_id'],
        'saved': {'output_ids': list(saved.output_ids),
                  'artifact_refs': list(saved.artifact_refs)},
    }
    data = _bytes(record)
    reference = checkpoints.save(data)  # Must register before progress is reported.
    try:
        saved_data = checkpoints.load(reference)
    except (KeyError, OSError) as error:
        raise RecordError('Checkpoint was not durably saved') from error
    _check_ref(reference, saved_data)
    if saved_data != data:
        raise RecordError('Saved checkpoint bytes differ')
    return UnitProgress('checkpointed', dict(job['native_extent']), {}, job['unit_id'],
                        saved, dict(reference))


def run_checkpointed_unit(job_json: str, *, run_id: str,
                          read_control: Callable[[str, str, int], ControlState | None],
                          registered: Callable[[dict[str, Any]], bool],
                          acquire: Callable[[dict[str, Any]], RecordSet],
                          prepare: Callable[[dict[str, Any]], RecordSet],
                          quality: Callable[[dict[str, Any]], RecordSet],
                          storage: CandidateStore, checkpoints: CheckpointStore,
                          max_retries: int = 1,
                          on_error: Callable[[str, BaseException], None] | None = None) -> UnitProgress:
    """Check Control before each attempt; preserve saved units on pause/cancel.

    A job envelope describes one bounded unit. The scheduler dispatches further
    units separately. Failures never claim completed coverage or promotion.
    """
    if type(max_retries) is not int or not 0 <= max_retries <= 3:
        raise ValueError('Retry limit must be between zero and three')
    job = parse_job_input(job_json)
    handlers = {'acquire': acquire, 'prepare': prepare, 'quality': quality}

    stage = 'checkpoint_recovery'

    def failure(code: str, detail: str | None = None) -> UnitProgress:
        return UnitProgress('failed', {}, dict(job['native_extent']), None, None, None, (code,), detail)

    def process(entry: dict[str, Any]) -> UnitProgress:
        nonlocal stage
        stage = 'checkpoint_recovery'
        resumed = _resume(entry, storage, checkpoints)
        if resumed is not None:
            if storage.read_rows is None:
                raise RecordError('Cannot verify candidate replay without saved rows')
            rows = [storage.read_row('prepared_output', i) for i in resumed.saved.output_ids]
            check_output_basis(entry, rows, registered_dependency_outputs(entry, storage))
            return resumed
        stage = 'acquiring_input' if entry['kind'] == 'acquire' else 'building_output'
        records = handlers[entry['kind']](entry)
        stage = 'validating_output'
        check_unit_records(entry, records, storage)
        # If a long-running builder finished after pause/cancel/supersession,
        # do not begin candidate writes. Control owns late-result acceptance.
        stage = 'control_check'
        execute_unit(job_json, run_id=run_id, read_control=read_control,
                     registered=registered, process=lambda _: None)
        stage = 'saving_output'
        saved = persist_candidate(records, storage)
        stage = 'verifying_output'
        if storage.read_rows is not None and saved.output_ids:
            checked = _saved_candidate(
                {'output_ids': list(saved.output_ids),
                 'artifact_refs': list(saved.artifact_refs)}, storage)
            if checked != saved:
                raise RecordError('Saved candidate is incomplete; cannot checkpoint')
        stage = 'saving_checkpoint'
        return _save(entry, saved, checkpoints)

    for retry in range(max_retries + 1):
        try:
            stage = 'control_check'
            return execute_unit(job_json, run_id=run_id, read_control=read_control,
                                registered=registered, process=process)
        except UnitNotRunnable:
            if retry == 0:
                raise  # Stage 1 refusal before any unit work.
            return failure('stopped')
        except StopWork as error:
            return failure(error.reason)
        except (RetryableUnitError, TimeoutError, ConnectionError) as error:
            if on_error is not None:
                on_error(stage, error)
            if retry == max_retries:
                return failure('transient_exhausted', stage_diagnostic(stage, transient=True))
        except ReaderBoundaryError as error:
            if on_error is not None:
                on_error(stage, error)
            return failure('reader_boundary', f'Reader marker {error.marker} crosses the requested native unit boundary')
        except ProviderError as error:
            if on_error is not None:
                on_error(stage, error)
            if error.transient and stage == 'saving_checkpoint' and retry < max_retries:
                continue
            return failure('provider_failure', provider_diagnostic(error, stage))
        except (RecordError, OSError) as error:
            if on_error is not None:
                on_error(stage, error)
            return failure('invalid_or_unavailable_output', stage_diagnostic(stage))
    raise AssertionError('Unreachable retry loop')

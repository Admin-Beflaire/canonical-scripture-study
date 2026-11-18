"""Save exact candidate-quality receipts and return the existing Control job result."""
from __future__ import annotations

import hashlib
import re
from typing import Any, Callable, Mapping, Sequence

from ..indexes.files import PAGE_CAP
from ..contracts import job_result, parse_job_input
from ..prepare.evidence import NativeText
from ..prepare.records import ReaderBoundaryError, RecordError, RecordSet
from ..provider import ProviderError, provider_diagnostic, quality_diagnostic
from ..validate.saved import CandidateInventory
from ..validate.semantic import _canonical, check_saved_semantics
from . import ControlState, UnitNotRunnable, execute_unit
from .checkpoints import CheckpointStore, _check_ref

_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}')


def check_candidate_quality(
    job_json: str, *, run_id: str,
    read_control: Callable[[str, str, int], ControlState | None],
    registered: Callable[[dict[str, Any]], bool],
    inventory: CandidateInventory,
    read_rows: Callable[[str, Sequence[str]], list[dict[str, Any]]],
    read_blob: Callable[[str], bytes],
    read_source: Callable[[str], NativeText],
    receipts: CheckpointStore,
    max_page_bytes: int = PAGE_CAP,
    read_reader_references: Callable[[Mapping[str, Any]], RecordSet] | None = None,
) -> dict[str, Any]:
    """Read-only candidate check; Control alone checks scope and promotes data."""
    job = parse_job_input(job_json)
    if job['kind'] != 'quality':
        raise RecordError('Only quality jobs may issue candidate-wide receipts')

    def result(state: str, **fields: Any) -> dict[str, Any]:
        return job_result(job, run_id=run_id,
            completed_extent=fields.get('completed_extent', {}),
            remaining_extent=fields.get('remaining_extent', dict(job['native_extent'])),
            output_refs=fields.get('output_refs', []),
            coverage_refs=fields.get('coverage_refs', []),
            checkpoint_ref=job['checkpoint_ref'],
            quality_receipt_ref=fields.get('quality_receipt_ref'),
            state=state, diagnostics=fields.get('diagnostics', []))

    def process(entry: dict[str, Any]) -> dict[str, Any]:
        stage = 'validating_candidate'
        try:
            if not entry['required_capabilities']:
                raise RecordError('Quality job must require at least one capability')
            evidence = check_saved_semantics(entry, inventory, read_rows=read_rows,
                read_blob=read_blob, read_source=read_source,
                max_page_bytes=max_page_bytes, read_reader_references=read_reader_references)
            if len(evidence.saved.artifact_refs) > 256 or len(evidence.coverage) > 256:
                raise RecordError('Candidate exceeds result reference limits')
            # The coverage identifier is the digest of the saved D1 composite
            # identity; its exact row and basis are included in the receipt.
            coverage_refs = [
                'coverage:' + hashlib.sha256(_canonical({
                    key: row[key] for key in ('output_id', 'source_revision_id', 'capability')
                })).hexdigest()[:32] for row in evidence.coverage]
            receipt = {
                'contract_version': 'preparation-quality/1',
                'task': {key: entry[key] for key in
                    ('task_id', 'task_revision', 'unit_id', 'attempt', 'basis_digest',
                     'manifest_revision', 'recipe_revision', 'native_extent',
                     'required_capabilities', 'input_refs', 'dependency_refs')},
                'job_input_sha256': hashlib.sha256(job_json.encode('utf-8')).hexdigest(),
                'run_id': run_id,
                'candidate': {
                    'added': [b.row() for b in inventory.added],
                    'reused': [b.row() for b in inventory.reused],
                    'omitted': list(inventory.omitted),
                    'output_ids': list(evidence.saved.output_ids),
                    'artifact_refs': list(evidence.saved.artifact_refs),
                },
                'coverage': list(evidence.coverage),
                'coverage_refs': coverage_refs,
                'actual_capabilities': list(evidence.capabilities),
                'checks': ['saved_inventory', 'artifact_digest', 'source_fidelity',
                           'native_coordinates', 'index_postings',
                           'relationship_endpoints', 'required_coverage',
                           *(['reader_references'] if read_reader_references is not None else [])],
                'limitations': list(evidence.limitations),
                'passed': True,
            }
            data = _canonical(receipt)
            # State can change during quality; do not issue a receipt for a
            # cancelled/superseded task. Control also rejects late results.
            stage = 'control_check'
            execute_unit(job_json, run_id=run_id, read_control=read_control,
                         registered=registered, process=lambda _: None)
            stage = 'saving_receipt'
            reference = receipts.save(data)
            stage = 'verifying_receipt'
            _check_ref(reference, receipts.load(reference))
            if receipts.load(reference) != data:
                raise RecordError('Saved quality receipt bytes differ')
            return result('succeeded', completed_extent=dict(entry['native_extent']),
                remaining_extent={}, output_refs=list(evidence.saved.artifact_refs),
                coverage_refs=coverage_refs, quality_receipt_ref=reference)
        except UnitNotRunnable:
            raise  # A late cancellation is not a failed quality check.
        except ReaderBoundaryError as error:
            return result('failed', diagnostics=[{'code': 'reader_boundary', 'message': str(error)}])
        except ProviderError as error:
            return result('failed', diagnostics=[{'code': 'provider_failure', 'message': provider_diagnostic(error, stage)}])
        except (RecordError, KeyError, ValueError, UnicodeError, OSError):
            return result('failed', diagnostics=[{
                'code': 'quality_failed', 'message': quality_diagnostic(stage)}])

    try:
        return execute_unit(job_json, run_id=run_id, read_control=read_control,
                            registered=registered, process=process)
    except ProviderError as error:
        return result('failed', diagnostics=[{'code': 'provider_failure',
                      'message': provider_diagnostic(error, 'control_check')}])
    except OSError:
        return result('failed', diagnostics=[{'code': 'quality_failed',
                      'message': quality_diagnostic('control_check')}])

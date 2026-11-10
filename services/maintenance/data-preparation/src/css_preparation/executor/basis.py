"""Bind one prepared unit's outputs to Control's dispatched source and extent.

The job has no general cross-versification mapping. A preparation job must use
native unit IDs; a caller must partition/translate book scope before dispatch.
"""
from __future__ import annotations

from typing import Any

from ..prepare.records import RecordError, RecordSet


def check_output_basis(job: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    if job['kind'] != 'prepare':
        if rows:
            raise RecordError('Only a prepare job can return prepared outputs')
        return
    if not rows:
        raise RecordError('Prepare job returned no candidate output')
    source_revisions = {ref['id'] for ref in job['input_refs'] if ref['kind'] == 'source_revision'}
    requested = job['native_extent'].get('unit_ids')
    if (not source_revisions or not isinstance(requested, list) or not requested
            or any(not isinstance(unit, str) for unit in requested)
            or len(set(requested)) != len(requested)):
        raise RecordError('Prepare job needs explicit source revision and native unit scope')
    ids = {row['id'] for row in rows}
    for row in rows:
        revisions = row['input_revisions_json']
        extent = row['native_extent_json']
        units = extent.get('unit_ids')
        if (not revisions or revisions[0] not in source_revisions
                or not isinstance(units, list) or not units
                or any(unit not in requested for unit in units)
                or ('coordinate_version' in job['native_extent']
                    and extent.get('coordinate_version') != job['native_extent']['coordinate_version'])):
            raise RecordError('Output source or native extent differs from dispatched unit')
        dependencies = set(row['validation_basis_json'].get('dependencies', []))
        known = ids | {ref['artifact_id'] for ref in job['dependency_refs']}
        if not dependencies.issubset(known):
            raise RecordError('Output has an undeclared or missing dependency')


def check_unit_records(job: dict[str, Any], records: RecordSet) -> None:
    if not isinstance(records, RecordSet):
        raise RecordError('Preparation module must return a RecordSet')
    check_output_basis(job, records.rows('prepared_output'))

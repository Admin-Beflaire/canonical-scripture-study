"""Executor side of the versioned Maintenance job envelopes (`schemas/maintenance/jobs.v1.schema.json`)."""
from __future__ import annotations

import json
from typing import Any

from .validation import SchemaSubset

CONTRACT_VERSION = 'maintenance-job/1'
_JOBS = SchemaSubset('maintenance/jobs.v1.schema.json')


class ContractError(ValueError):
    """A job envelope does not match the versioned contract."""


def contract_errors(name: str, value: Any) -> list[str]:
    """Return the problems with a `job_input` or `job_result` envelope; empty means valid."""
    if name not in ('job_input', 'job_result'):
        raise ValueError(name)
    return _JOBS.errors(name, value)


def parse_job_input(text: str) -> dict[str, Any]:
    """Decode and validate the job input Control dispatched."""
    value = json.loads(text)
    errors = contract_errors('job_input', value)
    if errors:
        raise ContractError('Invalid job input: ' + '; '.join(errors[:5]))
    return value


def job_result(job: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """Build a checkpoint/result envelope that repeats the job's identity and basis."""
    result = {'contract_version': CONTRACT_VERSION, **{key: job[key] for key in
              ('task_id', 'task_revision', 'unit_id', 'attempt', 'basis_digest')}, **fields}
    errors = contract_errors('job_result', result)
    if errors:
        raise ContractError('Invalid job result: ' + '; '.join(errors[:5]))
    return result

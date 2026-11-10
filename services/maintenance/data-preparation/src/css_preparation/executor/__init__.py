"""One-unit Python preparation entry, using Control's existing job contract.

Control supplies a read-only snapshot of its recorded task and dispatched job;
Stage 2 will provide the actual module callbacks and registered-input reader.
This module performs no storage, provider, admission or release-selection work.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Any, Callable, TypeVar

from ..contracts import ContractError, parse_job_input


@dataclass(frozen=True)
class ControlState:
    """Control task and recorded job fields needed before starting one unit."""

    task_id: str
    task_revision: int
    task_state: str
    task_basis_digest: str
    unit_id: str
    attempt: int
    job_revision: int
    job_input_basis: str
    run_id: str | None
    job_state: str


class UnitNotRunnable(ContractError):
    """The job is invalid, unregistered or no longer eligible to run."""


T = TypeVar('T')
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}')
_ACTIVE_JOBS = frozenset(('dispatched', 'running', 'checkpointed'))


def execute_unit(job_json: str, *, run_id: str,
                 read_control: Callable[[str, str, int], ControlState | None],
                 registered: Callable[[dict[str, Any]], bool],
                 process: Callable[[dict[str, Any]], T]) -> T:
    """Check the exact dispatched job before invoking one unit's processing.

    run_id comes from the trusted runner, not the job envelope. read_control
    reads the Control task and saved dispatch together; registered checks an
    exact source/acquisition/artifact reference against the candidate registry.
    Later stages supply those adapters without changing the versioned wire format.
    """
    job = parse_job_input(job_json)
    if not isinstance(run_id, str) or not _ID.fullmatch(run_id):
        raise UnitNotRunnable('Invalid runner identity')

    state = read_control(job['task_id'], job['unit_id'], job['attempt'])
    if state is None:
        raise UnitNotRunnable('No recorded Control dispatch')
    if (state.task_id != job['task_id'] or state.unit_id != job['unit_id'] or
            state.attempt != job['attempt'] or state.job_revision != job['task_revision'] or
            state.task_basis_digest != job['basis_digest'] or state.run_id != run_id):
        raise UnitNotRunnable('Control task or dispatch does not match the job')

    # Control increments the task revision when queued -> running. A job dispatched
    # while already running uses the unchanged revision. Other revision changes
    # (pause, resume, supersede) invalidate this run.
    if (state.task_state != 'running' or
            state.task_revision not in (job['task_revision'], job['task_revision'] + 1) or
            state.job_state not in _ACTIVE_JOBS):
        raise UnitNotRunnable('Control task or job is not runnable')

    # Control hashes canonicalJson(job) and sends those exact UTF-8 JSON bytes.
    # Do not parse/serialize again: Python and JavaScript format some numbers differently.
    exact_basis = hashlib.sha256(job_json.encode('utf-8')).hexdigest()
    if exact_basis != state.job_input_basis:
        raise UnitNotRunnable('Dispatched job inputs changed')

    refs = list(job['input_refs'])
    refs.extend({'kind': 'artifact', 'id': item['artifact_id'], 'sha256': item['sha256'],
                 'byte_count': item['byte_count']} for item in job['dependency_refs'])
    if job['checkpoint_ref'] is not None:
        item = job['checkpoint_ref']
        refs.append({'kind': 'artifact', 'id': item['artifact_id'], 'sha256': item['sha256'],
                     'byte_count': item['byte_count']})
    for ref in refs:
        if not registered(ref):
            raise UnitNotRunnable('Input, dependency or checkpoint is not registered')

    return process(job)

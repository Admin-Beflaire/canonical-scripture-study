"""Client for Control's internal job routes (`/internal/jobs/*`, Access Service Auth).

The preparation runner reads the recorded task/dispatch before work and submits its
`maintenance-job/1` result afterwards. The paths and bodies are fixed by
`tests/conformance/internal-jobs.v1.json`, which Control (MC-02) implements.
A runner identity cannot create tasks, approve scope, promote data or deploy.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
import time
from typing import Any, Callable

from ..contracts import contract_errors
from ..executor import ControlState
from .web import Origin, ProviderError

STATE_PATH = '/internal/jobs/state'
RESULT_PATH = '/internal/jobs/result'
_COMMIT = re.compile(r'[0-9a-f]{40}')
_FIELDS = {
    'task_id': str, 'task_revision': int, 'task_state': str, 'task_basis_digest': str, 'unit_id': str,
    'attempt': int, 'job_revision': int, 'job_input_basis': str, 'run_id': (str, type(None)), 'job_state': str,
}


@dataclass(frozen=True)
class ControlConfig:
    origin: Origin
    client_id: str
    client_secret: str

    def __post_init__(self) -> None:
        for value in (self.client_id, self.client_secret):
            if not isinstance(value, str) or not value or any(c.isspace() for c in value):
                raise ValueError('Missing internal-job service token')


class ControlClient:
    def __init__(self, config: ControlConfig, *, attempts: int = 3,
                 sleep: Callable[[float], None] = time.sleep):
        self._config = config
        self._headers = {'CF-Access-Client-Id': config.client_id,
                         'CF-Access-Client-Secret': config.client_secret}
        self._attempts = attempts
        self._sleep = sleep

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        for attempt in range(self._attempts):
            try:
                return self._config.origin.json('POST', path, self._headers, body)
            except ProviderError as error:
                if not error.transient or attempt == self._attempts - 1:
                    raise
                self._sleep(2 ** attempt)
        raise AssertionError('unreachable')

    def read_state(self, task_id: str, unit_id: str, attempt: int) -> ControlState | None:
        """Control's recorded task and dispatch for this attempt, or None when none exists."""
        try:
            reply = self._post(STATE_PATH, {'task_id': task_id, 'unit_id': unit_id, 'attempt': attempt})
        except ProviderError as error:
            if error.status == 404:
                return None
            raise
        if not isinstance(reply, dict) or set(reply) != set(_FIELDS) or any(
                not isinstance(reply[key], kind) or (kind is int and isinstance(reply[key], bool))
                for key, kind in _FIELDS.items()):
            raise ProviderError('Control state reply does not match the internal-job contract')
        return ControlState(**reply)

    def submit_result(self, result: dict[str, Any], commit: str) -> dict[str, Any]:
        """Send the result with the reviewed workflow commit; repeated sends are idempotent in Control."""
        errors = contract_errors('job_result', result)
        if errors or not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
            raise ValueError('Result or commit does not match the contract')
        reply = self._post(RESULT_PATH, {'result': result, 'commit': commit})
        if not isinstance(reply, dict) or reply.get('status') not in ('accepted', 'duplicate', 'rejected'):
            raise ProviderError('Control result reply does not match the internal-job contract')
        return reply

"""Short-lived diagnostics: only fields we explicitly know are safe to publish."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import traceback

from ..prepare.records import RecordError
from ..provider import ProviderError, provider_diagnostic

# Each matching phrase is assembled by our reviewed transfer client.
_SAFE_ACQUIRE = re.compile(
    r'Acquisition failed: [A-Za-z0-9._:/-]{1,200}: '
    r'(?:only HTTPS is allowed|destination is outside the declared route|'
    r'a byte limit is required|server answered [1-5][0-9]{2}|'
    r'transfer failed|partial answer without a matching basis|'
    r'resumed at the wrong offset|larger than the declared limit|'
    r'bytes differ from the expected revision)\Z'
)


class DiagnosticRecorder:
    """Write safe JSON lines, retained for one day by the workflow."""

    def __init__(self, path: str | None, *, run_id: str, kind: str):
        self.path = Path(path) if path else None
        self.run_id = run_id if run_id.isdecimal() else 'unknown'
        self.kind = kind if kind in ('acquire', 'prepare', 'quality', 'validate') else 'unknown'

    def _write(self, record: dict) -> None:
        if self.path is None:
            return
        record = {
            'timestamp_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'run_id': self.run_id, 'kind': self.kind, **record,
        }
        try:
            with self.path.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(record, sort_keys=True) + '\n')
        except OSError:
            pass  # Diagnostics never change the task's outcome.

    def exception(self, stage: str, error: BaseException) -> None:
        frames = [
            {'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
            for frame in traceback.extract_tb(error.__traceback__)
            if '/css_preparation/' in frame.filename.replace('\\', '/')
        ]
        entry: dict = {'event': 'exception', 'stage': stage, 'exception': type(error).__name__,
                       'frames': frames[-12:]}
        if isinstance(error, ProviderError):
            entry['detail'] = provider_diagnostic(error, stage)
            if type(error.status) is int and 100 <= error.status <= 599:
                entry['http_status'] = error.status
        elif isinstance(error, RecordError) and _SAFE_ACQUIRE.fullmatch(str(error)):
            entry['detail'] = str(error)
        self._write(entry)

    def outcome(self, state: str) -> None:
        if state in ('succeeded', 'failed', 'cancelled'):
            self._write({'event': 'result', 'state': state})

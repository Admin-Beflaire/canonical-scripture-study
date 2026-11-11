"""Candidate D1 rows (Cloudflare REST API) and private R2 objects (R2's S3-compatible API).

One preparation API token is enough: D1 write on the account, and R2 object read/write on
the project's bucket only. R2 object access uses the S3-compatible API with credentials
derived from that token (see `r2.py`), because the REST API rejects bucket-scoped tokens
for objects. These adapters supply DP-04's storage boundaries. They never write release
rows or `release_selection`: the statements come from `RecordSet`, which has no release tables.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Any, Sequence

from ..executor.candidate import CandidateStore
from ..executor.checkpoints import CheckpointStore
from ..prepare.records import KEYS, TABLES, decoded, scoped_query
from .r2 import R2Objects
from .web import Origin, ProviderError

_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}')
_HEX = re.compile(r'[0-9a-f]{64}')
_PAGE_ROWS = 500           # Keeps each paged result far below D1's 50 MB response limit.
_BATCH_STATEMENTS = 1000   # One unit's candidate rows; larger units must be split by the recipe.
_BOUND_IDS = 90            # D1 binds at most 100 parameters per statement (two more for paging).


@dataclass(frozen=True)
class CloudflareConfig:
    account_id: str
    database_id: str
    bucket: str
    token: str
    r2_access_key_id: str
    api: Origin = Origin('https://api.cloudflare.com')
    r2_origin: Origin | None = None  # Default: https://<account>.r2.cloudflarestorage.com

    def __post_init__(self) -> None:
        for value in (self.account_id, self.database_id, self.bucket):
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', value):
                raise ValueError('Invalid Cloudflare resource identifier')
        if not isinstance(self.token, str) or not self.token or any(c.isspace() for c in self.token):
            raise ValueError('Missing preparation API token')
        if not isinstance(self.r2_access_key_id, str) or not re.fullmatch(r'[0-9a-f]{32}', self.r2_access_key_id):
            raise ValueError('R2 access key ID must be the preparation token ID')


class CloudflareStorage:
    """D1 query/batch and immutable R2 object access for one preparation run."""

    def __init__(self, config: CloudflareConfig):
        self._config = config
        self._headers = {'Authorization': f'Bearer {config.token}'}
        self._d1 = f'/client/v4/accounts/{config.account_id}/d1/database/{config.database_id}/query'
        self._objects = R2Objects(config.account_id, config.bucket, config.r2_access_key_id, config.token, config.r2_origin)

    # D1 -----------------------------------------------------------------
    def _query(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        reply = self._config.api.json('POST', self._d1, self._headers, body)
        if not isinstance(reply, dict) or reply.get('success') is not True or not isinstance(reply.get('result'), list):
            raise ProviderError('D1 query was not successful')
        for item in reply['result']:
            if not isinstance(item, dict) or item.get('success') is False or not isinstance(item.get('results', []), list):
                raise ProviderError('D1 statement was not successful')
        return reply['result']

    def select(self, sql: str, params: list[Any]) -> list[dict[str, Any]]:
        [result] = self._query({'sql': sql, 'params': params})
        return decoded(result.get('results', []))

    def write_rows(self, statements: list[tuple[str, list[Any]]]) -> None:
        """Send one unit's inserts as one D1 batch, so a partial unit is not acknowledged."""
        if not statements or len(statements) > _BATCH_STATEMENTS:
            raise ProviderError('Candidate unit has no rows or too many rows for one batch')
        for sql, _ in statements:
            if not sql.startswith('INSERT INTO ') or 'release' in sql.split('(', 1)[0]:
                raise ProviderError('Only candidate inserts may be written')
        self._query({'batch': [{'sql': sql, 'params': params} for sql, params in statements]})

    def read_row(self, kind: str, identity: str) -> dict[str, Any] | None:
        keys = KEYS.get(kind)
        if keys is None or len(keys) != 1 or not isinstance(identity, str):
            return None
        rows = self.select(f'SELECT * FROM {TABLES[kind]} WHERE {keys[0]} = ? LIMIT 2', [identity])
        if len(rows) > 1:
            raise ProviderError('Duplicate saved identity')
        return rows[0] if rows else None

    def read_rows(self, kind: str, output_ids: Sequence[str]) -> list[dict[str, Any]]:
        """The saved `kind` rows of these outputs only (see `scoped_query`), paged.

        Output IDs are bound in chunks to stay within D1's bound-parameter limit; rows reached
        through more than one chunk (a shared payload or source identity) are returned once.
        """
        if kind not in KEYS:
            raise ValueError('Unknown record kind')
        ids = list(dict.fromkeys(output_ids))
        if not ids:
            return []
        order = ', '.join(KEYS[kind])
        rows: dict[tuple[Any, ...], dict[str, Any]] = {}
        for start in range(0, len(ids), _BOUND_IDS):
            sql, params = scoped_query(kind, ids[start:start + _BOUND_IDS])
            offset = 0
            while True:
                page = self.select(f'SELECT * FROM ({sql}) ORDER BY {order} LIMIT ? OFFSET ?',
                                   params + [_PAGE_ROWS, offset])
                for row in page:
                    rows.setdefault(tuple(row[key] for key in KEYS[kind]), row)
                offset += len(page)
                if len(page) < _PAGE_ROWS:
                    break
        return [rows[key] for key in sorted(rows)]

    # R2 -----------------------------------------------------------------
    @staticmethod
    def _key(key: str) -> str:
        if not isinstance(key, str) or not key or len(key) > 1024 or key.startswith('/') or '..' in key.split('/'):
            raise ProviderError('Invalid object key')
        return key

    def read_blob(self, key: str) -> bytes:
        data = self._objects.get(self._key(key))
        if data is None:
            raise KeyError('Saved object is missing')
        return data

    def put_blob(self, key: str, data: bytes) -> None:
        """Write once: identical bytes at an existing key are kept; different bytes are refused.

        Keys must be content-addressed (the bytes' SHA-256 is a path segment or `<sha256>.json`),
        and the write is an atomic create (`If-None-Match: *`), so stored content is never replaced.
        """
        digest = hashlib.sha256(data).hexdigest()
        if digest not in key.split('/') and f'{digest}.json' not in key.split('/'):
            raise ProviderError('Object key is not addressed by its content digest')
        if self._objects.create(self._key(key), data):
            return
        # The key already exists (atomic create refused): accept identical bytes only.
        if self._objects.get(key) != data:
            raise ProviderError('Immutable object already holds different bytes')

    # Boundaries for DP-04 -------------------------------------------------
    def candidate_store(self) -> CandidateStore:
        return CandidateStore(put_blob=self.put_blob, read_blob=self.read_blob, write_rows=self.write_rows,
                              read_row=self.read_row, read_rows=self.read_rows)

    def record_store(self, prefix: str) -> CheckpointStore:
        """Content-addressed private records (checkpoints, quality receipts) outside release data."""
        if prefix not in ('checkpoints', 'receipts'):
            raise ValueError('Unknown private record kind')

        def key(digest: str) -> str:
            return f'prepared/{prefix}/{digest}.json'

        def save(data: bytes) -> dict[str, Any]:
            digest = hashlib.sha256(data).hexdigest()
            self.put_blob(key(digest), data)
            return {'artifact_id': f'{prefix[:-1]}:{digest[:32]}', 'sha256': digest, 'byte_count': len(data)}

        def load(reference: dict[str, Any]) -> bytes:
            digest = reference.get('sha256') if isinstance(reference, dict) else None
            if not isinstance(digest, str) or not _HEX.fullmatch(digest):
                raise KeyError('Invalid private record reference')
            return self.read_blob(key(digest))

        return CheckpointStore(save=save, load=load)

    def registered(self, reference: dict[str, Any]) -> bool:
        """Is a job input, dependency or checkpoint reference saved exactly as stated?"""
        if not isinstance(reference, dict) or not _ID.fullmatch(str(reference.get('id', ''))):
            return False
        kind, identity = reference.get('kind'), reference['id']
        if kind == 'source_revision':
            row = self.read_row('source_node', identity)
            return row is not None and row.get('kind') == 'source_revision'
        if kind != 'artifact':
            return False  # Acquisition descriptors resolve through reviewed recipes (DP-05).
        digest, size = reference.get('sha256'), reference.get('byte_count')
        if identity.startswith(('checkpoint:', 'receipt:')):
            prefix = 'checkpoints' if identity.startswith('checkpoint:') else 'receipts'
            if not isinstance(digest, str) or not _HEX.fullmatch(digest) or identity.split(':', 1)[1] != digest[:32]:
                return False
            try:
                data = self.read_blob(f'prepared/{prefix}/{digest}.json')
            except KeyError:
                return False
            return len(data) == size and hashlib.sha256(data).hexdigest() == digest
        row = self.read_row('artifact', identity)
        return row is not None and row.get('sha256') == digest and row.get('byte_count') == size

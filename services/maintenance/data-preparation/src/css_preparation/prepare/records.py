"""Validated candidate evidence records and their parameterised SQL.

Every row is checked against `schemas/` before it is accepted. Preparation writes only
candidate-scoped evidence: release rows and `release_selection` belong to Maintenance
Control and are refused here.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from ..validation import SCHEMAS, SchemaSubset

_RECORDS = SchemaSubset('evidence-records.v1.schema.json')
_SEGMENTS = SchemaSubset('indexes/span-segment.v1.schema.json')
TABLES: dict[str, str] = {
    **json.loads((SCHEMAS / 'evidence.v1.manifest.json').read_text(encoding='utf-8'))['record_tables'],
    'span_segment': 'span_segments',
}
# Insert order satisfies the foreign keys in migrations 0001-0002.
ORDER = ('source_node', 'admission', 'prepared_output', 'text_payload', 'artifact', 'native_span', 'span_segment',
         'annotation', 'relationship', 'relation_member', 'coverage', 'study_package', 'character_statement')
KEYS: dict[str, tuple[str, ...]] = {
    'source_node': ('id',), 'admission': ('id',), 'prepared_output': ('id',), 'text_payload': ('content_id',),
    'artifact': ('id',), 'native_span': ('id',), 'span_segment': ('span_id', 'segment_ordinal'), 'annotation': ('id',),
    'relationship': ('id',), 'relation_member': ('relationship_id', 'role', 'ordinal'),
    'coverage': ('output_id', 'source_revision_id', 'capability'), 'study_package': ('id',),
    'character_statement': ('id',),
}
# Shared immutable identities may already be saved; an identical row is kept, a different one fails.
SHARED = ('source_node', 'text_payload')


class RecordError(ValueError):
    """A record does not match its contract or conflicts with one already prepared."""


def _sql_value(name: str, value: Any) -> Any:
    if name.endswith('_json'):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    if isinstance(value, bool):
        return int(value)
    return value


class RecordSet:
    """Rows by record kind, in insertion order, plus generated artifact bytes."""

    def __init__(self) -> None:
        self._rows: dict[str, dict[tuple[Any, ...], dict[str, Any]]] = {kind: {} for kind in ORDER}
        self.blobs: dict[str, bytes] = {}

    def add(self, kind: str, row: dict[str, Any]) -> dict[str, Any]:
        if kind not in self._rows:
            raise RecordError(f'Preparation does not write {kind} records')
        errors = _SEGMENTS.document_errors(row) if kind == 'span_segment' else _RECORDS.errors(kind, row)
        if errors:
            raise RecordError(f'Invalid {kind}: ' + '; '.join(errors[:5]))
        key = tuple(row[name] for name in KEYS[kind])
        existing = self._rows[kind].get(key)
        if existing is not None and existing != row:
            raise RecordError(f'Conflicting {kind} {key}')
        self._rows[kind].setdefault(key, dict(row))
        return row

    def add_blob(self, artifact_id: str, data: bytes) -> None:
        if self.blobs.get(artifact_id, data) != data:
            raise RecordError(f'Conflicting bytes for artifact {artifact_id}')
        self.blobs[artifact_id] = bytes(data)

    def rows(self, kind: str) -> list[dict[str, Any]]:
        return [dict(row) for row in self._rows[kind].values()]

    def merge(self, other: 'RecordSet') -> 'RecordSet':
        for kind in ORDER:
            for row in other._rows[kind].values():
                self.add(kind, row)
        for artifact_id, data in other.blobs.items():
            self.add_blob(artifact_id, data)
        return self

    def output_ids(self) -> list[str]:
        return [row['id'] for row in self._rows['prepared_output'].values()]

    def statements(self) -> list[tuple[str, list[Any]]]:
        """Parameterised inserts in foreign-key order, for SQLite or the D1 query interface."""
        result = []
        for kind in ORDER:
            table = TABLES[kind]
            for row in self._rows[kind].values():
                columns = list(row)
                values = [_sql_value(name, row[name]) for name in columns]
                if kind in SHARED:
                    # Insert unless an identical row exists; a different row with the same key still fails.
                    same = ' AND '.join(f'{name} IS ?' for name in columns)
                    sql = (f"INSERT INTO {table} ({','.join(columns)}) SELECT {','.join('?' for _ in columns)} "
                           f'WHERE NOT EXISTS (SELECT 1 FROM {table} WHERE {same})')
                    result.append((sql, values + values))
                else:
                    result.append((f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                                   values))
        return result


def decoded(rows: Iterable[Any]) -> list[dict[str, Any]]:
    """SQLite rows back to contract values (JSON columns decoded)."""
    return [{key: json.loads(value) if key.endswith('_json') and isinstance(value, str) else value
             for key, value in dict(row).items()} for row in rows]


def migrations() -> list[Path]:
    return sorted((SCHEMAS / 'migrations').glob('*.sql'))

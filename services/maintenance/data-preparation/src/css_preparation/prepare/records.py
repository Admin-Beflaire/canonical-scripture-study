"""Validated candidate evidence records and their parameterised SQL.

Every row is checked against `schemas/` before it is accepted. Preparation writes only
candidate-scoped evidence: release rows and `release_selection` belong to Maintenance
Control and are refused here.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Sequence

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
# A component's admission record is the same for every task that acquires it.
SHARED = ('source_node', 'admission', 'text_payload')


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

    def without_outputs(self, output_ids: Iterable[str]) -> 'RecordSet':
        """A copy without the rows and bytes owned by these outputs.

        Used when an identical output is already saved: its owned rows are not written
        again. Shared identities (sources, admissions, payloads) stay, because their
        inserts keep an identical saved row.
        """
        drop = set(output_ids)
        spans = {row['id'] for row in self._rows['native_span'].values() if row['output_id'] in drop}
        relations = {row['id'] for row in self._rows['relationship'].values() if row['output_id'] in drop}
        result = RecordSet()
        for kind in ORDER:
            for key, row in self._rows[kind].items():
                if ((kind == 'prepared_output' and row['id'] in drop)
                        or (kind in _BY_OUTPUT and row['output_id'] in drop)
                        or (kind == 'span_segment' and row['span_id'] in spans)
                        or (kind == 'relation_member' and row['relationship_id'] in relations)):
                    continue
                result._rows[kind][key] = dict(row)
        kept = {row['id'] for row in result._rows['artifact'].values()}
        result.blobs = {key: data for key, data in self.blobs.items() if key in kept}
        return result

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


_BY_OUTPUT = ('artifact', 'native_span', 'annotation', 'relationship', 'coverage', 'study_package',
              'character_statement')


def scoped_query(kind: str, output_ids: Sequence[str]) -> tuple[str, list[Any]]:
    """SELECT for the saved `kind` rows that belong to these prepared outputs.

    Quality and checkpoint checks read only their candidate's rows, never whole tables:
    output-owned rows by output, navigation, members and payloads through their spans or
    relationships, and source identities through the outputs' input revisions and their
    ancestry. The query binds each output ID once.
    """
    if kind not in KEYS:
        raise RecordError('Unknown record kind')
    if not output_ids or any(not isinstance(item, str) for item in output_ids):
        raise RecordError('Scoped reads need output identities')
    marks = ','.join('?' for _ in output_ids)
    table = TABLES[kind]
    revisions = (f'SELECT value FROM prepared_outputs, json_each(prepared_outputs.input_revisions_json) '
                 f'WHERE prepared_outputs.id IN ({marks})')
    if kind == 'prepared_output':
        where = f'id IN ({marks})'
    elif kind in _BY_OUTPUT:
        where = f'output_id IN ({marks})'
    elif kind == 'span_segment':
        where = f'span_id IN (SELECT id FROM native_spans WHERE output_id IN ({marks}))'
    elif kind == 'text_payload':
        where = f'content_id IN (SELECT content_id FROM native_spans WHERE output_id IN ({marks}))'
    elif kind == 'relation_member':
        where = f'relationship_id IN (SELECT id FROM relationships WHERE output_id IN ({marks}))'
    elif kind == 'admission':
        where = f'source_revision_id IN ({revisions})'
    else:  # source_node: the input revisions and every ancestor
        return (f'SELECT * FROM {table} WHERE id IN (WITH RECURSIVE ancestry(id) AS ({revisions} '
                f'UNION SELECT s.parent_id FROM {table} s JOIN ancestry a ON s.id = a.id '
                f'WHERE s.parent_id IS NOT NULL) SELECT id FROM ancestry)', list(output_ids))
    return f'SELECT * FROM {table} WHERE {where}', list(output_ids)


def decoded(rows: Iterable[Any]) -> list[dict[str, Any]]:
    """SQLite rows back to contract values (JSON columns decoded)."""
    return [{key: json.loads(value) if key.endswith('_json') and isinstance(value, str) else value
             for key, value in dict(row).items()} for row in rows]


def migrations() -> list[Path]:
    return sorted((SCHEMAS / 'migrations').glob('*.sql'))

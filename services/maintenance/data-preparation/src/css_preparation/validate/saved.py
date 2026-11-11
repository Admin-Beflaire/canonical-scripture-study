"""Read-only integrity check of an explicit saved candidate inventory.

New and reused outputs receive the same checks. Omitted outputs may still exist
in storage, but are never inspected as included output or chosen for a release.
Source fidelity and semantic relationships are checked by semantic quality.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Any, Callable, Iterable, Mapping, Sequence

from ..indexes.saved import verify_saved_index
from ..prepare.evidence import OutputBasis, reusable
from ..prepare.records import ORDER, RecordError
from ..validation import SchemaSubset

_RECORDS = SchemaSubset('evidence-records.v1.schema.json')
_SEGMENTS = SchemaSubset('indexes/span-segment.v1.schema.json')
_SCOPED = ('artifact', 'native_span', 'annotation', 'relationship', 'coverage',
           'study_package', 'character_statement')


@dataclass(frozen=True)
class CandidateInventory:
    """Exact target membership provided by Control; no release membership writes."""

    added: tuple[OutputBasis, ...]
    reused: tuple[OutputBasis, ...] = ()
    omitted: tuple[str, ...] = ()


@dataclass(frozen=True)
class SavedInventory:
    output_ids: tuple[str, ...]
    artifact_refs: tuple[dict[str, Any], ...]
    index_ids: tuple[str, ...]


def _unique(rows: Iterable[Mapping], key: str, kind: str) -> dict[str, dict]:
    indexed: dict[str, dict] = {}
    for item in rows:
        row = dict(item)
        identity = row.get(key)
        if not isinstance(identity, str) or identity in indexed:
            raise RecordError(f'Duplicate or invalid saved {kind} identity')
        indexed[identity] = row
    return indexed


def _schema(kind: str, row: dict) -> None:
    errors = (_SEGMENTS.document_errors(row) if kind == 'span_segment'
              else _RECORDS.errors(kind, row))
    if errors:
        raise RecordError(f'Invalid saved {kind}: ' + '; '.join(errors[:3]))


def verify_candidate_inventory(
    inventory: CandidateInventory, *,
    read_rows: Callable[[str, Sequence[str]], Iterable[Mapping[str, Any]]],
    read_blob: Callable[[str], bytes],
    max_page_bytes: int = 2048,
) -> SavedInventory:
    """Read D1 rows and registered R2 bytes, not in-memory builder records.

    The runner supplies a read-only D1 reader scoped to the candidate's output IDs, and a
    private-R2 reader keyed by each stored artifact's registered_locator. This
    routine has no provider calls, release selection, or source admission logic.
    """
    bases = (*inventory.added, *inventory.reused)
    if any(type(b) is not OutputBasis for b in bases):
        raise RecordError('Candidate needs exact output bases')
    output_ids = tuple(b.output_id for b in bases)
    included = set(output_ids)
    omitted = set(inventory.omitted)
    if (not bases or len(included) != len(bases)
            or len(omitted) != len(inventory.omitted) or included & omitted):
        raise RecordError('Candidate has duplicate, empty or contradictory membership')
    for basis in bases:
        if not set(basis.dependencies).issubset(included):
            raise RecordError('Included output has a missing or omitted dependency')

    # Load the saved records once. Old, unselected candidate rows may coexist;
    # only rows attached to the explicit included output IDs are authoritative.
    data = {kind: tuple(dict(row) for row in read_rows(kind, output_ids)) for kind in ORDER}
    prepared = _unique((r for r in data['prepared_output'] if r.get('id') in included),
                       'id', 'prepared_output')
    if set(prepared) != included:
        raise RecordError('Missing saved candidate output')
    for basis in bases:
        row = prepared[basis.output_id]
        _schema('prepared_output', row)
        if not reusable(row, basis):
            raise RecordError('Saved candidate has an incompatible input or method basis')

    scoped = {kind: [r for r in data[kind] if r.get('output_id') in included]
              for kind in _SCOPED}
    for kind, rows in scoped.items():
        for row in rows:
            _schema(kind, row)

    artifacts = _unique(scoped['artifact'], 'id', 'artifact')
    blobs: dict[str, bytes] = {}
    for artifact_id, row in artifacts.items():
        try:
            content = read_blob(row['registered_locator'])
        except (KeyError, OSError) as exc:
            raise RecordError(f'Missing saved R2 object: {artifact_id}') from exc
        if (not isinstance(content, bytes) or len(content) != row['byte_count']
                or hashlib.sha256(content).hexdigest() != row['sha256']):
            raise RecordError(f'Corrupt or incomplete saved R2 object: {artifact_id}')
        blobs[artifact_id] = content

    coverage = scoped['coverage']
    for basis in bases:
        own = [r for r in coverage if r['output_id'] == basis.output_id]
        if basis.kind in ('evidence', 'source_search', 'word_index') and not own:
            raise RecordError('Missing saved output coverage')
        for row in own:
            if (row['source_revision_id'] != basis.input_revisions[0]
                    or row['method_version'] != basis.method_version
                    or row['dependencies_json'] != sorted(basis.dependencies)):
                raise RecordError('Saved output coverage is incompatible with its basis')
            ref = row['index_artifact_id']
            if ref is not None and (ref not in artifacts or
                                    artifacts[ref]['output_id'] != basis.output_id):
                raise RecordError('Coverage references an absent or foreign artifact')

    spans = _unique(scoped['native_span'], 'id', 'native_span')
    selected_spans = tuple(spans.values())
    for basis in bases:
        if basis.kind == 'evidence' and not any(
                r['output_id'] == basis.output_id for r in selected_spans):
            raise RecordError('Missing saved native span records')

    payload_ids = {s['content_id'] for s in selected_spans if s['content_id'] is not None}
    payloads = _unique((r for r in data['text_payload'] if r.get('content_id') in payload_ids),
                       'content_id', 'text_payload')
    if set(payloads) != payload_ids:
        raise RecordError('Missing saved D1 text payload')
    for row in payloads.values():
        _schema('text_payload', row)
        if hashlib.sha256(row['exact_text'].encode('utf-8')).hexdigest() != row['content_id']:
            raise RecordError('Saved text payload digest mismatch')

    segments = [r for r in data['span_segment'] if r.get('span_id') in spans]
    for row in segments:
        _schema('span_segment', row)
    segments_by_span: dict[str, list[dict]] = {}
    for row in segments:
        segments_by_span.setdefault(row['span_id'], []).append(row)
    for span in selected_spans:
        own = segments_by_span.get(span['id'], [])
        if len(own) != len(span['segments_json']) or sorted(
                r['segment_ordinal'] for r in own) != list(range(len(own))):
            raise RecordError('Missing or duplicate saved navigation segment')
        for br in span['body_ranges_json']:
            ref = artifacts.get(br['artifact_id'])
            if ref is None or ref['output_id'] != span['output_id']:
                raise RecordError('Native span references a missing stored artifact')
            content = blobs[br['artifact_id']]
            start, length = br['byte_offset'], br['byte_length']
            if (start + length > len(content)
                    or hashlib.sha256(content[start:start + length]).hexdigest() != br['sha256']):
                raise RecordError('Saved native body range has incorrect bytes or digest')

    # Validate saved source-revision identities through their required ancestry.
    nodes = _unique(data['source_node'], 'id', 'source_node')
    for basis in bases:
        if basis.kind not in ('evidence', 'source_search', 'word_index'):
            continue
        next_id = basis.input_revisions[0]
        for kind in ('source_revision', 'representation', 'edition', 'work'):
            node = nodes.get(next_id)
            if node is None:
                raise RecordError('Missing saved source identity')
            _schema('source_node', node)
            if node['kind'] != kind:
                raise RecordError('Saved source ancestry is incompatible')
            next_id = node['parent_id']

    relations = _unique(scoped['relationship'], 'id', 'relationship')
    members = [r for r in data['relation_member'] if r.get('relationship_id') in relations]
    for row in members:
        _schema('relation_member', row)
    member_relationship_ids = {m['relationship_id'] for m in members}
    for row in relations.values():
        if row['id'] not in member_relationship_ids:
            raise RecordError('Missing saved relationship members')
    for row in scoped['annotation']:
        if row['span_id'] not in spans:
            raise RecordError('Saved annotation names absent native span')

    checked_indexes = []
    for basis in bases:
        if basis.kind in ('source_search', 'word_index'):
            verify_saved_index(basis, prepared[basis.output_id], scoped['artifact'],
                               coverage, blobs, max_page_bytes=max_page_bytes)
            checked_indexes.append(basis.output_id)
    return SavedInventory(output_ids, tuple({
        'artifact_id': r['id'], 'sha256': r['sha256'], 'byte_count': r['byte_count']
    } for r in sorted(artifacts.values(), key=lambda row: row['id'])), tuple(checked_indexes))

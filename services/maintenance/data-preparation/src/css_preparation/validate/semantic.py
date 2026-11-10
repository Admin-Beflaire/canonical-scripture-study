"""Candidate-wide semantic checks against saved D1/R2 and retained native input.

Stage 4 validates storage bytes and index manifests. This module verifies exact
source wording, native coordinates, evidence endpoints and truthful coverage.
No release membership or promotion decisions are made here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Callable, Mapping

from ..prepare.evidence import NativeText, span_wording
from ..prepare.records import ORDER, RecordError
from .saved import CandidateInventory, SavedInventory, verify_candidate_inventory


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                      separators=(',', ':')).encode('utf-8')


@dataclass(frozen=True)
class SemanticEvidence:
    saved: SavedInventory
    coverage: tuple[dict[str, Any], ...]
    capabilities: tuple[str, ...]
    limitations: tuple[str, ...]


def check_saved_semantics(
    job: dict[str, Any], inventory: CandidateInventory, *,
    read_rows: Callable[[str], list[dict[str, Any]]],
    read_blob: Callable[[str], bytes],
    read_source: Callable[[str], NativeText],
    max_page_bytes: int = 2048,
) -> SemanticEvidence:
    """Never substitute a builder's success flag for saved candidate evidence."""
    saved = verify_candidate_inventory(inventory, read_rows=read_rows, read_blob=read_blob,
                                       max_page_bytes=max_page_bytes)
    included = set(saved.output_ids)
    revisions = {ref['id'] for ref in job['input_refs'] if ref['kind'] == 'source_revision'}
    if not revisions or any(b.input_revisions[0] not in revisions
                            for b in (*inventory.added, *inventory.reused)):
        raise RecordError('Candidate inputs disagree with dispatched registered sources')
    rows = {kind: [dict(row) for row in read_rows(kind)] for kind in ORDER}
    artifacts = {r['id']: r for r in rows['artifact'] if r['output_id'] in included}
    blobs = {}
    for key, row in artifacts.items():
        try:
            data = read_blob(row['registered_locator'])
        except (KeyError, OSError) as error:
            raise RecordError('Saved artifact missing during semantic validation') from error
        # The saved-inventory check performed an earlier read; fail closed if
        # an object changes between validation and semantic inspection.
        if (not isinstance(data, bytes) or len(data) != row['byte_count']
                or hashlib.sha256(data).hexdigest() != row['sha256']):
            raise RecordError('Saved artifact changed during semantic validation')
        blobs[key] = data
    texts = {r['content_id']: r['exact_text'] for r in rows['text_payload']}
    spans = {r['id']: r for r in rows['native_span'] if r['output_id'] in included}
    segments = {(r['span_id'], r['segment_ordinal']): r for r in rows['span_segment']
                if r['span_id'] in spans}
    native: dict[str, NativeText] = {}

    def source(revision: str) -> NativeText:
        if revision not in native:
            value = read_source(revision)
            if not isinstance(value, NativeText):
                raise RecordError('Registered native source could not be read')
            native[revision] = value
        return native[revision]

    for basis in (*inventory.added, *inventory.reused):
        if basis.kind == 'evidence':
            text = source(basis.input_revisions[0])
            if text.coordinate_version != basis.extent.get('coordinate_version'):
                raise RecordError('Saved native coordinate version does not match source')
    for span in spans.values():
        text = source(span['source_revision_id'])
        if text.coordinate_version != span['coordinate_version']:
            raise RecordError('Saved native span has incompatible source coordinates')
        parent = span['parent_id']
        if parent is not None and parent not in spans:
            raise RecordError('Saved native span has missing parent')
        pieces = []
        bases = text.scalar_bases()
        for ordinal, segment in enumerate(span['segments_json']):
            unit = segment['unit_id']
            body = text.unit(unit)
            start, end = segment['start'], segment['end']
            if (start < 0 or end > len(body) or end < start
                    or unit not in next(b.extent['unit_ids'] for b in
                        (*inventory.added, *inventory.reused) if b.output_id == span['output_id'])):
                raise RecordError('Saved native span exceeds its declared coordinates')
            segment_row = segments.get((span['id'], ordinal))
            expected_start = bases[unit] + start
            expected_end = bases[unit] + max(end - 1, start)
            if (segment_row is None or segment_row['start_order'] != expected_start
                    or segment_row['end_order'] != expected_end
                    or segment_row['source_revision_id'] != span['source_revision_id']
                    or segment_row['kind'] != span['kind']):
                raise RecordError('Saved navigation segment does not round trip to source')
            pieces.append(body[start:end])
        wording = span_wording(span, texts, blobs)
        if span['reading_kind'] in ('preserved', 'transcribed', 'extracted') and wording != pieces:
            raise RecordError('Saved wording does not match registered native source')
        if span['reading_kind'] == 'gap' and any(piece for piece in wording):
            raise RecordError('Saved gap contains wording')

    members_by_relation: dict[str, list[dict]] = {}
    for member in rows['relation_member']:
        members_by_relation.setdefault(member['relationship_id'], []).append(member)
    for relation in (r for r in rows['relationship'] if r['output_id'] in included):
        members = members_by_relation.get(relation['id'], [])
        for member in members:
            endpoint = member['span_id']
            if endpoint is not None and endpoint not in spans:
                raise RecordError('Relationship has an absent native endpoint')
        keys = [(m['role'], m['ordinal']) for m in members]
        if len(keys) != len(set(keys)):
            raise RecordError('Relationship has duplicate ordered members')

    for index in (b for b in (*inventory.added, *inventory.reused)
                  if b.kind in ('source_search', 'word_index')):
        text = source(index.input_revisions[0])
        bases = text.scalar_bases()
        for artifact in (r for r in artifacts.values()
                         if r['output_id'] == index.output_id and
                         r['format'] == 'application/x-ndjson'):
            for line in blobs[artifact['id']].splitlines():
                try:
                    posting = json.loads(line)
                except (ValueError, UnicodeError) as error:
                    raise RecordError('Saved native posting is malformed') from error
                if not isinstance(posting, dict):
                    raise RecordError('Saved native posting is not an object')
                ref = posting.get('native_reference')
                if not isinstance(ref, dict) or not isinstance(ref.get('segments'), list) or not ref['segments']:
                    raise RecordError('Saved native posting has no segments')
                pieces = []
                for segment in ref['segments']:
                    body = text.unit(segment['unit_id'])
                    start, end = segment['start'], segment['end']
                    if (start < 0 or end > len(body) or end <= start
                            or segment['unit_id'] not in index.extent['unit_ids']):
                        raise RecordError('Saved posting is outside native source extent')
                    pieces.append(body[start:end])
                first = ref['segments'][0]
                if (posting['coordinate_version'] != text.coordinate_version
                        or posting['native_order'] != bases[first['unit_id']] + first['start']
                        or posting['span_id'] not in spans):
                    raise RecordError('Saved posting native reference disagrees with source')
                owner = spans[posting['span_id']]
                if owner['source_revision_id'] != index.input_revisions[0]:
                    raise RecordError('Saved posting span names another source')
                if not all(any(s['unit_id'] == p['unit_id'] and
                               s['start'] <= p['start'] and p['end'] <= s['end']
                               for s in owner['segments_json']) for p in ref['segments']):
                    raise RecordError('Saved posting is outside its native evidence span')
                if posting['posting_kind'] == 'word' and posting['form'] not in ''.join(pieces):
                    raise RecordError('Saved word form disagrees with source wording')

    coverage = tuple(sorted((dict(row) for row in rows['coverage'] if row['output_id'] in included),
                            key=lambda row: (row['output_id'], row['source_revision_id'], row['capability'])))
    required_units = job['native_extent'].get('unit_ids')
    if not isinstance(required_units, list) or not required_units:
        raise RecordError('Quality job requires explicit native unit scope')
    covered_capabilities = sorted({row['capability'] for row in coverage
                                   if row['state'] == 'available'})
    for capability in job['required_capabilities']:
        actual_units = set()
        for row in coverage:
            if row['capability'] == capability and row['state'] == 'available':
                actual_units.update(row['native_extent_json'].get('unit_ids', ()))
        if not set(required_units).issubset(actual_units):
            raise RecordError('Required capability coverage is incomplete')
    limitations = tuple(sorted({row['limitation'] for row in coverage
                                if row['state'] != 'available' and row['limitation']}))
    return SemanticEvidence(saved, coverage, tuple(covered_capabilities), limitations)

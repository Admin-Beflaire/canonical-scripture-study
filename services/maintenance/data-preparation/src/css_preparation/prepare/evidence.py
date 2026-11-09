"""Native evidence records for one source revision.

An adapter supplies the source identity, the exact native text units and the spans it
recognised; this module turns them into Data Layer records without changing the wording.
Short single-segment bodies become D1 text payloads; other bodies become registered,
uncompressed UTF-8 byte ranges in one generated R2 artifact per output.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from typing import Any, Iterable, Mapping

from .records import RecordError, RecordSet

READING_KINDS = ('preserved', 'transcribed', 'extracted', 'restored', 'reconstructed', 'variant', 'translation', 'gap')


def _surrogate_free(text: str) -> bool:
    return not any(0xD800 <= ord(character) <= 0xDFFF for character in text)


def canonical_digest(value: Any) -> str:
    """SHA-256 of stable JSON, used for reuse bases (not for text identity)."""
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class SourceLevel:
    id: str
    name: str
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SourceIdentity:
    """Work, edition, representation and exact revision keep separate identities."""
    work: SourceLevel
    edition: SourceLevel
    representation: SourceLevel
    revision: SourceLevel
    attribution: str
    origin: str
    versification_scheme: str | None = None

    def rows(self) -> list[dict[str, Any]]:
        result, parent = [], None
        for kind, level in (('work', self.work), ('edition', self.edition),
                            ('representation', self.representation), ('source_revision', self.revision)):
            details = dict(level.details)
            if kind == 'source_revision' and self.versification_scheme is not None:
                if details.get('versification_scheme', self.versification_scheme) != self.versification_scheme:
                    raise RecordError('Conflicting versification scheme')
                details['versification_scheme'] = self.versification_scheme
            result.append({'id': level.id, 'kind': kind, 'parent_id': parent, 'name': level.name,
                           'attribution': self.attribution, 'origin': self.origin, 'details_json': details})
            parent = level.id
        return result


@dataclass(frozen=True)
class NativeText:
    """Exact unit texts in native order, addressed by Unicode-scalar offsets of one coordinate version."""
    coordinate_version: str
    units: tuple[tuple[str, str], ...]
    complete: bool = True
    limitation: str | None = None
    _index: dict[str, str] = field(init=False, repr=False, compare=False)

    def __post_init__(self):
        ids = [unit_id for unit_id, _ in self.units]
        if not self.units or len(set(ids)) != len(ids):
            raise RecordError('Native text needs distinct unit identities')
        for unit_id, text in self.units:
            if not unit_id or not isinstance(text, str) or not _surrogate_free(unit_id + text):
                raise RecordError(f'Invalid native unit {unit_id!r}')
        if not self.complete and not self.limitation:
            raise RecordError('Partial native text needs a stated limitation')
        object.__setattr__(self, '_index', dict(self.units))

    def unit(self, unit_id: str) -> str:
        try:
            return self._index[unit_id]
        except (KeyError, TypeError):
            raise RecordError(f'Unknown native unit {unit_id!r}') from None

    def byte_bases(self) -> dict[str, int]:
        bases, offset = {}, 0
        for unit_id, text in self.units:
            bases[unit_id] = offset
            offset += len(text.encode('utf-8'))
        return bases

    def scalar_bases(self) -> dict[str, int]:
        """Linear source order of each unit's first scalar, for navigation intervals."""
        bases, offset = {}, 0
        for unit_id, text in self.units:
            bases[unit_id] = offset
            offset += len(text)
        return bases


@dataclass(frozen=True)
class SpanSpec:
    """A recognised native span. `key` is unique within its output."""
    key: str
    kind: str
    label: str
    segments: tuple[tuple[str, int, int], ...]
    reading_kind: str
    basis: Mapping[str, Any]
    parent_key: str | None = None


@dataclass(frozen=True)
class AnnotationSpec:
    key: str
    span_key: str
    kind: str
    provider: str
    basis: Mapping[str, Any]
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OutputBasis:
    """Everything that decides whether a saved output can be reused."""
    kind: str
    input_revisions: tuple[str, ...]
    method_version: str
    parameters: Mapping[str, Any]
    extent: Mapping[str, Any]
    dependencies: tuple[str, ...] = ()

    def digest(self) -> str:
        return canonical_digest({'kind': self.kind, 'input_revisions': list(self.input_revisions),
                                 'method_version': self.method_version, 'parameters': dict(self.parameters),
                                 'extent': dict(self.extent), 'dependencies': sorted(self.dependencies)})

    @property
    def output_id(self) -> str:
        return f'{self.kind}:{self.digest()[:32]}'

    def row(self) -> dict[str, Any]:
        return {'id': self.output_id, 'kind': self.kind, 'input_revisions_json': list(self.input_revisions),
                'method_version': self.method_version, 'parameters_json': dict(self.parameters),
                'native_extent_json': dict(self.extent),
                'validation_basis_json': {'reuse_basis': self.digest(), 'dependencies': sorted(self.dependencies)}}


def reusable(saved_output: Mapping[str, Any], basis: OutputBasis) -> bool:
    """A saved output row is reusable only when its complete recorded basis matches.

    Saved-artifact integrity is checked separately by quality before reuse.
    """
    return dict(saved_output) == basis.row()


def span_id(output_id: str, key: str) -> str:
    return f'{output_id}#{key}'


def _check_segments(text: NativeText, spec: SpanSpec) -> list[str]:
    if not spec.segments:
        raise RecordError(f'Span {spec.key} has no segments')
    seen: dict[str, list[tuple[int, int]]] = {}
    pieces = []
    for unit_id, start, end in spec.segments:
        body = text.unit(unit_id)
        if not (isinstance(start, int) and isinstance(end, int)) or not 0 <= start <= end <= len(body):
            raise RecordError(f'Span {spec.key} segment {unit_id} {start}-{end} is outside its unit')
        for other_start, other_end in seen.get(unit_id, ()):
            if start < other_end and other_start < end:
                raise RecordError(f'Span {spec.key} segments overlap in {unit_id}')
        seen.setdefault(unit_id, []).append((start, end))
        pieces.append(body[start:end])
    return pieces


def _ordered(specs: Iterable[SpanSpec]) -> list[SpanSpec]:
    """Parents before children; reject unknown parents and cycles."""
    by_key: dict[str, SpanSpec] = {}
    for spec in specs:
        if spec.key in by_key:
            raise RecordError(f'Duplicate span key {spec.key}')
        by_key[spec.key] = spec
    ordered, placed = [], set()

    def place(spec: SpanSpec, trail: tuple[str, ...]) -> None:
        if spec.key in placed:
            return
        if spec.key in trail:
            raise RecordError(f'Span parent cycle at {spec.key}')
        if spec.parent_key is not None:
            if spec.parent_key not in by_key:
                raise RecordError(f'Span {spec.key} has unknown parent {spec.parent_key}')
            place(by_key[spec.parent_key], trail + (spec.key,))
        placed.add(spec.key)
        ordered.append(spec)

    for spec in by_key.values():
        place(spec, ())
    return ordered


def build_evidence(source: SourceIdentity, text: NativeText, spans: Iterable[SpanSpec], basis: OutputBasis, *,
                   d1_body_max_bytes: int, annotations: Iterable[AnnotationSpec] = ()) -> RecordSet:
    """Prepare one output for one source revision: identities, spans, bodies, annotations, coverage."""
    revision = source.revision.id
    if basis.input_revisions[:1] != (revision,):
        raise RecordError('The output basis must name this source revision first')
    if basis.extent.get('coordinate_version') != text.coordinate_version:
        # Coordinates are part of the reuse basis: other coordinates are never the same output.
        raise RecordError('The output extent must record the native coordinate version')
    if d1_body_max_bytes < 0:
        raise RecordError('Body size limit must not be negative')
    records = RecordSet()
    for row in source.rows():
        records.add('source_node', row)
    output_id = basis.output_id
    records.add('prepared_output', basis.row())

    body_bytes = b''.join(unit.encode('utf-8') for _, unit in text.units)
    body_digest = hashlib.sha256(body_bytes).hexdigest()
    body_artifact = f'{output_id}:body'
    byte_bases = text.byte_bases()
    uses_body = False
    native_order = 0
    reachable: dict[str, list[tuple[int, int]]] = {}
    spec_list = _ordered(spans)
    for spec in spec_list:
        if spec.reading_kind not in READING_KINDS:
            raise RecordError(f'Span {spec.key} has unknown reading kind {spec.reading_kind}')
        pieces = _check_segments(text, spec)
        encoded = [piece.encode('utf-8') for piece in pieces]
        content_id, ranges = None, []
        if spec.reading_kind == 'gap':
            if any(encoded):
                raise RecordError(f'Gap span {spec.key} must not carry wording')
        elif not any(encoded):
            raise RecordError(f'Span {spec.key} has no wording; mark a missing reading as a gap')
        else:
            for unit_id, start, end in spec.segments:
                reachable.setdefault(unit_id, []).append((start, end))
            if len(encoded) == 1 and len(encoded[0]) <= d1_body_max_bytes:
                content_id = hashlib.sha256(encoded[0]).hexdigest()
                records.add('text_payload', {'content_id': content_id, 'exact_text': pieces[0]})
            else:
                uses_body = True
                for ordinal, ((unit_id, start, _), data) in enumerate(zip(spec.segments, encoded)):
                    offset = byte_bases[unit_id] + len(text.unit(unit_id)[:start].encode('utf-8'))
                    ranges.append({'segment_ordinal': ordinal, 'artifact_id': body_artifact, 'byte_offset': offset,
                                   'byte_length': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        if uses_body and ranges and not any(row['id'] == body_artifact for row in records.rows('artifact')):
            records.add('artifact', {'id': body_artifact, 'source_revision_id': revision, 'output_id': output_id,
                                     'sha256': body_digest, 'byte_count': len(body_bytes), 'format': 'text/utf-8',
                                     'registered_locator': f'prepared/{body_digest}/native-body.txt'})
            records.add_blob(body_artifact, body_bytes)
        records.add('native_span', {
            'id': span_id(output_id, spec.key), 'output_id': output_id, 'source_revision_id': revision,
            'parent_id': span_id(output_id, spec.parent_key) if spec.parent_key else None,
            'kind': spec.kind, 'label': spec.label, 'native_order': native_order,
            'coordinate_version': text.coordinate_version,
            'segments_json': [{'unit_id': u, 'start': s, 'end': e} for u, s, e in spec.segments],
            'basis_json': dict(spec.basis), 'content_id': content_id, 'body_ranges_json': ranges,
            'reading_kind': spec.reading_kind})
        native_order += 1

    for row in navigation_rows(records.rows('native_span'), text):
        records.add('span_segment', row)
    keys = {spec.key for spec in spec_list}
    for note in annotations:
        if note.span_key not in keys:
            raise RecordError(f'Annotation {note.key} names unknown span {note.span_key}')
        records.add('annotation', {'id': f'{output_id}@{note.key}', 'output_id': output_id,
                                   'source_revision_id': revision, 'span_id': span_id(output_id, note.span_key),
                                   'kind': note.kind, 'provider': note.provider, 'basis_json': dict(note.basis),
                                   'details_json': dict(note.details)})
    covered = [unit_id for unit_id, body in text.units if _fully_reached(len(body), reachable.get(unit_id, []))]
    unreached = [unit_id for unit_id, _ in text.units if unit_id not in covered]
    limitations = ([text.limitation] if not text.complete else []) + (
        [f'{len(unreached)} supplied unit(s) not retrievable through any span: ' + ', '.join(unreached[:10])
         + (' …' if len(unreached) > 10 else '')] if unreached else [])
    state = 'missing' if not covered else 'partial' if limitations else 'available'
    records.add('coverage', {
        'output_id': output_id, 'source_revision_id': revision, 'native_extent_json': {'unit_ids': covered},
        'capability': 'source_context', 'state': state,
        'method_version': basis.method_version, 'index_artifact_id': body_artifact if uses_body else None,
        'dependencies_json': sorted(basis.dependencies), 'limitation': '; '.join(limitations) or None})
    return records


def _fully_reached(length: int, intervals: list[tuple[int, int]]) -> bool:
    """Coverage claims a unit only when non-gap spans expose every scalar of its wording."""
    position = 0
    for start, end in sorted(intervals):
        if start > position:
            return False
        position = max(position, end)
    return position >= length


def navigation_rows(spans: Iterable[Mapping[str, Any]], text: NativeText) -> list[dict[str, Any]]:
    """One `span_segments` row per native segment, as inclusive linear source-order intervals.

    Source order counts Unicode scalars across the revision's units in native order, so
    overlap queries work across unit boundaries. An empty segment marks its insertion point.
    """
    bases = text.scalar_bases()
    rows = []
    for span in spans:
        for ordinal, segment in enumerate(span['segments_json']):
            start = bases[segment['unit_id']] + segment['start']
            end = bases[segment['unit_id']] + max(segment['end'] - 1, segment['start'])
            rows.append({'span_id': span['id'], 'segment_ordinal': ordinal,
                         'source_revision_id': span['source_revision_id'], 'kind': span['kind'],
                         'start_order': start, 'end_order': end})
    return rows


def span_wording(span: Mapping[str, Any], payloads: Mapping[str, str], blobs: Mapping[str, bytes]) -> list[str]:
    """Exact wording per native segment from saved records, verifying every range digest."""
    if span['reading_kind'] == 'gap':
        return ['' for _ in span['segments_json']]
    if span['content_id'] is not None:
        text = payloads[span['content_id']]
        if hashlib.sha256(text.encode('utf-8')).hexdigest() != span['content_id']:
            raise RecordError(f"Payload digest mismatch for {span['id']}")
        return [text]
    result = []
    for expected, item in enumerate(span['body_ranges_json']):
        if item['segment_ordinal'] != expected:
            raise RecordError(f"Body ranges of {span['id']} are not in segment order")
        data = blobs[item['artifact_id']][item['byte_offset']:item['byte_offset'] + item['byte_length']]
        if len(data) != item['byte_length'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise RecordError(f"Body range digest mismatch for {span['id']}")
        result.append(data.decode('utf-8', errors='strict'))
    if len(result) != len(span['segments_json']):
        raise RecordError(f"Body ranges of {span['id']} do not cover every segment")
    return result

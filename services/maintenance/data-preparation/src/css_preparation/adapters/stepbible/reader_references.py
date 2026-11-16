"""Prepare a bounded NRSVA navigation output from STEPBible's reader markers."""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Sequence

from ...prepare.evidence import OutputBasis, SpanSpec, build_evidence, canonical_digest, span_id
from ...prepare.literary import LiteraryUnit, literary_spans
from ...prepare.records import RecordError, RecordSet
from ...validation import SCHEMAS
from .prepare import MAX_STATEMENTS, book_text, book_verses, read_component
from .source import Component

_METHOD = 'stepbible-reader-reference/1'
_TITLE = 'superscription'
_TEXT = 'numbered_text'
Anchor = tuple[str, int, int]
Segment = tuple[str, int, int]


@dataclass
class _Reading:
    markers: set[str] = field(default_factory=set)
    segments: list[Segment] = field(default_factory=list)


def _reader_anchor(marker: str, chapter_ends: dict, code: str) -> tuple[Anchor, str]:
    book, chapter, verse = marker.split('.')
    if book != code:
        raise RecordError(f'Reader marker {marker} names a different book from {code}')
    chapter, verse = int(chapter), int(verse)
    role = _TEXT
    if verse == 0 and chapter_ends['book_id'] == 'Ps':
        verse, role = 1, _TITLE
    ends = chapter_ends['last_verses']
    first = chapter_ends.get('first_verse_overrides', {}).get(str(chapter), 1)
    if not 1 <= chapter <= len(ends) or not first <= verse <= ends[chapter - 1]:
        raise RecordError(f'Reader marker {marker} is outside the NRSVA catalogue')
    return (chapter_ends['book_id'], chapter, verse), role


def _checked_ranges(anchors: list[Anchor]) -> list[dict]:
    ranges: list[dict] = []
    for book, chapter, verse in sorted(anchors):
        if (ranges and ranges[-1]['book_id'] == book and ranges[-1]['chapter'] == chapter
                and ranges[-1]['last_verse'] + 1 == verse):
            ranges[-1]['last_verse'] = verse
        else:
            ranges.append({'book_id': book, 'chapter': chapter, 'first_verse': verse, 'last_verse': verse})
    return ranges


def prepare_reader_reference_unit(
    data: bytes, component: Component, book: str, unit_ids: Sequence[str], *,
    literary_units: Sequence[LiteraryUnit] = (),
) -> RecordSet:
    """Build candidate rows. Each reader anchor must be wholly within the requested native unit batch."""
    if not unit_ids or len(set(unit_ids)) != len(unit_ids):
        raise RecordError('A reader-reference unit needs distinct native verses')
    catalogue = json.loads((SCHEMAS / 'reader-references/nrsva-1.json').read_text(encoding='utf-8'))
    books = [row for row in catalogue['books'] if book == row['book_id'] or book in row['aliases']]
    if len(books) != 1:
        raise RecordError(f'Book {book} does not identify one NRSVA catalogue book')
    [chapter_ends] = books
    version = catalogue['reader_scheme_version']
    verses = book_verses(read_component(data, component), component, book)
    selected = set(unit_ids)
    chosen = [verse for verse in verses if verse.unit_id in selected]
    text = book_text(verses, component, book, [verse.unit_id for verse in chosen])
    if len(chosen) != len(selected):
        raise RecordError('Requested native verses are not all in this book')

    groups: dict[Anchor, dict[str, _Reading]] = {}
    native_anchors: dict[str, set[Anchor]] = {}
    for verse in chosen:
        previous = None
        anchors = native_anchors.setdefault(verse.unit_id, set())
        for word, bounds in zip(verse.words, verse.ranges, strict=True):
            anchor, role = _reader_anchor(word.reference, chapter_ends, book)
            reading = groups.setdefault(anchor, {}).setdefault(role, _Reading())
            reading.markers.add(word.reference)
            anchors.add(anchor)
            if bounds is not None and bounds[0] < bounds[1]:
                start, end = bounds
                if previous == (anchor, role) and reading.segments and reading.segments[-1][0] == verse.unit_id:
                    start = reading.segments[-1][1]
                    reading.segments[-1] = (verse.unit_id, start, end)
                else:
                    reading.segments.append((verse.unit_id, start, end))
            previous = (anchor, role)

    # A superscription and the numbered text it accompanies can cross native verse boundaries.
    for verse in verses:
        if verse.unit_id in selected:
            continue
        for marker in verse.references:
            _, chapter, number = marker.split('.')
            number = int(number)
            if number == 0 and chapter_ends['book_id'] == 'Ps':
                number = 1
            if (chapter_ends['book_id'], int(chapter), number) in groups:
                raise RecordError(f'Reader marker {marker} crosses the requested native unit boundary')

    native_by_anchor = {anchor: f'{book}.{anchor[1]}.{anchor[2]}' for anchor in groups}
    baselines: list[Anchor] = []
    spans: list[SpanSpec] = []
    links: list[dict] = []
    for anchor, roles in groups.items():
        native = native_by_anchor[anchor]
        numbered = roles.get(_TEXT)
        if (list(roles) == [_TEXT] and native in selected and native_anchors[native] == {anchor}
                and numbered.segments == [(native, 0, len(text.unit(native)))]):
            baselines.append(anchor)
            continue
        reader_ref = '.'.join(map(str, anchor))
        for ordinal, role in enumerate((_TITLE, _TEXT) if _TITLE in roles else (_TEXT,)):
            reading = roles.get(role, _Reading())
            segment_key = f'{reader_ref}:{role}'
            basis = {'source_markers': sorted(reading.markers)}
            if reading.segments:
                spans.append(SpanSpec(segment_key, role, reader_ref, tuple(reading.segments), 'extracted', basis))
            status = 'missing' if not reading.segments else 'composite' if len(reading.segments) > 1 else 'exact'
            links.append(dict(key=segment_key, has_span=bool(reading.segments), reader_ref=reader_ref,
                              role=role, ordinal=ordinal, status=status, basis_json=basis,
                              gap_reason=None if reading.segments else 'No base wording for this reader role'))

    supplied_units = literary_spans(text, literary_units)
    basis = OutputBasis(
        'reader_reference', (component.revision_id,), _METHOD,
        {'reader_scheme_version': version, 'inventory_digest': canonical_digest(catalogue),
         'literary_units': [{'key': span.key, 'label': span.label, 'segments': span.segments,
                             'reading_kind': span.reading_kind, 'basis': dict(span.basis),
                             'parent_key': span.parent_key} for span in supplied_units]},
        {'coordinate_version': text.coordinate_version, 'unit_ids': [verse.unit_id for verse in chosen]},
    )
    records = build_evidence(component.identity(), text, [*spans, *supplied_units], basis,
                             d1_body_max_bytes=0, source_context_coverage=False)
    output_id = basis.output_id
    common = dict(output_id=output_id, source_revision_id=component.revision_id, reader_scheme_version=version)
    if baselines:
        records.add('reader_reference_base', dict(
            **common, id=f'{output_id}:base', native_scheme_version=component.source.versification,
            checked_extent_json={'ranges': _checked_ranges(baselines)},
            basis_json={'method': _METHOD, 'marker': 'leading NRSV word reference'},
        ))
    for link in links:
        key, has_span = link.pop('key'), link.pop('has_span')
        records.add('reader_reference_link', dict(
            **common, **link, id=f'{output_id}:{key}', span_id=span_id(output_id, key) if has_span else None,
        ))
    if len(records.statements()) > MAX_STATEMENTS:
        raise RecordError('Reader-reference unit exceeds one D1 batch')
    return records

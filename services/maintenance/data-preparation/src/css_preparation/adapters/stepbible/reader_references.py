"""Prepare a bounded NRSVA navigation output from STEPBible's reader markers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from ...prepare.evidence import OutputBasis, SpanSpec, canonical_digest
from ...prepare.literary import LiteraryUnit, literary_spans
from ...prepare.records import ReaderBoundaryError, RecordError, RecordSet
from ...prepare.reader_references import Anchor, build_reader_output, reader_catalogue
from ...prepare.reader_references import READER_REFERENCE as READER_REFERENCE
from .prepare import book_text, book_verses, read_component
from .source import Component

_METHOD = "stepbible-reader-reference/1"
_TITLE = "superscription"
_TEXT = "numbered_text"
Segment = tuple[str, int, int]


@dataclass
class _Reading:
    markers: set[str] = field(default_factory=set)
    segments: list[Segment] = field(default_factory=list)


def _reader_anchor(marker: str, chapter_ends: dict, code: str) -> tuple[Anchor, str]:
    book, chapter, verse = marker.split(".")
    if book != code:
        raise RecordError(f"Reader marker {marker} names a different book from {code}")
    chapter, verse = int(chapter), int(verse)
    role = _TEXT
    if verse == 0 and chapter_ends["book_id"] == "Ps":
        verse, role = 1, _TITLE
    ends = chapter_ends["last_verses"]
    first = chapter_ends.get("first_verse_overrides", {}).get(str(chapter), 1)
    if not 1 <= chapter <= len(ends) or not first <= verse <= ends[chapter - 1]:
        raise RecordError(f"Reader marker {marker} is outside the NRSVA catalogue")
    return (chapter_ends["book_id"], chapter, verse), role


def prepare_reader_reference_unit(  # noqa: C901, PLR0915
    data: bytes,
    component: Component,
    book: str,
    unit_ids: Sequence[str],
    *,
    literary_units: Sequence[LiteraryUnit] = (),
) -> RecordSet:
    """Build candidate rows. Each reader anchor must be wholly within the requested native unit batch."""
    if not unit_ids or len(set(unit_ids)) != len(unit_ids):
        raise RecordError("A reader-reference unit needs distinct native verses")
    catalogue, chapter_ends = reader_catalogue(book)
    version = catalogue["reader_scheme_version"]
    verses = book_verses(read_component(data, component), component, book)
    selected = set(unit_ids)
    chosen = [verse for verse in verses if verse.unit_id in selected]
    text = book_text(verses, component, book, [verse.unit_id for verse in chosen])
    if len(chosen) != len(selected):
        raise RecordError("Requested native verses are not all in this book")

    groups: dict[Anchor, dict[str, _Reading]] = {}
    native_anchors: dict[str, set[Anchor]] = {}
    for verse in chosen:
        previous_wording = None
        anchors = native_anchors.setdefault(verse.unit_id, set())
        for word, bounds in zip(verse.words, verse.ranges, strict=True):
            anchor, role = _reader_anchor(word.reference, chapter_ends, book)
            reading = groups.setdefault(anchor, {}).setdefault(role, _Reading())
            reading.markers.add(word.reference)
            anchors.add(anchor)
            if bounds is not None and bounds[0] < bounds[1]:
                start, end = bounds
                if (
                    previous_wording == (anchor, role)
                    and reading.segments
                    and reading.segments[-1][0] == verse.unit_id
                ):
                    start = reading.segments[-1][1]
                    reading.segments[-1] = (verse.unit_id, start, end)
                else:
                    reading.segments.append((verse.unit_id, start, end))
                previous_wording = (anchor, role)

    # A superscription and the numbered text it accompanies can cross native verse boundaries.
    for verse in verses:
        if verse.unit_id in selected:
            continue
        for marker in verse.references:
            _, chapter, number = marker.split(".")
            number = int(number)
            if number == 0 and chapter_ends["book_id"] == "Ps":
                number = 1
            if (chapter_ends["book_id"], int(chapter), number) in groups:
                raise ReaderBoundaryError(marker)

    native_by_anchor = {anchor: f"{book}.{anchor[1]}.{anchor[2]}" for anchor in groups}
    baselines: list[Anchor] = []
    spans: list[SpanSpec] = []
    links: list[dict] = []
    for anchor, roles in groups.items():
        native = native_by_anchor[anchor]
        numbered = roles.get(_TEXT)
        if (
            list(roles) == [_TEXT]
            and native in selected
            and native_anchors[native] == {anchor}
            and numbered.segments == [(native, 0, len(text.unit(native)))]
        ):
            baselines.append(anchor)
            continue
        reader_ref = ".".join(map(str, anchor))
        for ordinal, role in enumerate(
            (_TITLE, _TEXT) if _TITLE in roles else (_TEXT,)
        ):
            reading = roles.get(role, _Reading())
            segment_key = f"{reader_ref}:{role}"
            basis = {"source_markers": sorted(reading.markers)}
            if reading.segments:
                spans.append(
                    SpanSpec(
                        segment_key,
                        role,
                        reader_ref,
                        tuple(reading.segments),
                        "extracted",
                        basis,
                    )
                )
            status = (
                "missing"
                if not reading.segments
                else "composite"
                if len(reading.segments) > 1
                else "exact"
            )
            links.append(
                dict(
                    key=segment_key,
                    has_span=bool(reading.segments),
                    reader_ref=reader_ref,
                    role=role,
                    ordinal=ordinal,
                    status=status,
                    basis_json=basis,
                    gap_reason=None
                    if reading.segments
                    else "No base wording for this reader role",
                )
            )

    supplied_units = literary_spans(text, literary_units)
    basis = OutputBasis(
        READER_REFERENCE,
        (component.revision_id,),
        _METHOD,
        {
            "reader_scheme_version": version,
            "inventory_digest": canonical_digest(catalogue),
            **component.reuse_parameters(),
            "literary_units": [
                {
                    "key": span.key,
                    "label": span.label,
                    "segments": span.segments,
                    "reading_kind": span.reading_kind,
                    "basis": dict(span.basis),
                    "parent_key": span.parent_key,
                }
                for span in supplied_units
            ],
            **(
                {"literary_chunk_bytes": 1024}
                if any(
                    len(text.unit(unit)[start:end].encode("utf-8")) > 1024
                    for span in supplied_units
                    for unit, start, end in span.segments
                )
                else {}
            ),
        },
        {
            "coordinate_version": text.coordinate_version,
            "unit_ids": [verse.unit_id for verse in chosen],
        },
    )
    return build_reader_output(
        component.identity(),
        text,
        basis,
        [*spans, *supplied_units],
        baselines,
        links,
        native_scheme=component.source.versification,
        base_evidence={"method": _METHOD, "marker": "leading NRSV word reference"},
        literary_span_count=len(supplied_units),
    )

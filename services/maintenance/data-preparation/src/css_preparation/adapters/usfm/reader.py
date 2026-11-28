"""Apply an edition-specific, checked reader correspondence to a USFM book."""

from collections import defaultdict
import hashlib
from typing import Any, Mapping

from ...prepare.evidence import (
    NativeText,
    OutputBasis,
    SourceIdentity,
    SpanSpec,
    canonical_digest,
)
from ...prepare.reader_references import (
    Anchor,
    READER_REFERENCE,
    build_reader_output,
    reader_catalogue,
)
from ...prepare.records import ReaderBoundaryError, RecordError, RecordSet


METHOD = "usfm-reader-reference/1"


def _anchors(book: Mapping[str, Any]) -> dict[str, Anchor]:
    code = book["book_id"]
    first = book.get("first_verse_overrides", {})
    return {
        f"{code}.{chapter}.{verse}": (code, chapter, verse)
        for chapter, last in enumerate(book["last_verses"], start=1)
        for verse in range(first.get(str(chapter), 1), last + 1)
    }


def _checked_offsets(text: NativeText, mapping: Mapping[str, Any]) -> None:
    hashes = mapping["checked_text_sha256"]
    for unit, digest in hashes.items():
        if hashlib.sha256(text.unit(unit).encode("utf-8")).hexdigest() != digest:
            raise RecordError(
                "USFM boundary evidence differs from the reviewed native text"
            )
    for finding in mapping["candidates"].values():
        if not finding["checked_native"] or not set(finding["checked_native"]).issubset(
            hashes
        ):
            raise RecordError("A USFM boundary finding lacks verified native evidence")


def _link_segments(
    text: NativeText, links: Mapping[str, Any], mapping: Mapping[str, Any]
) -> set[str]:
    used: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for link in links.values():
        finding = mapping["candidates"][link["finding"]]
        candidate = finding["checked_native"]
        if not link["segments"] and (
            link["scope_unit"] not in candidate or not link["gap_reason"]
        ):
            raise RecordError("Reader gap needs a checked scope and reason")
        for unit, start, stop in link["segments"]:
            if unit not in candidate or not 0 <= start < stop <= len(text.unit(unit)):
                raise RecordError("Reader link is outside its verified native span")
            used[unit].append((start, stop))
    for unit, ranges in used.items():
        body, end = text.unit(unit), 0
        for start, stop in sorted(ranges):
            if end > start or body[end:start].strip():
                raise RecordError(
                    "Reader boundary spans overlap or omit native wording"
                )
            end = stop
        if body[end:].strip():
            raise RecordError("Reader boundary spans omit native wording")
    return set(used)


def checked_anchors(
    book: str, text: NativeText, mapping: Mapping[str, Any]
) -> dict[str, Anchor]:
    """Check the complete profile, references and separately evidenced exceptions."""
    catalogue, reader_book = reader_catalogue(book)
    if (
        catalogue["reader_scheme_version"] != mapping["scheme"]
        or canonical_digest(catalogue) != mapping["catalogue_sha256"]
    ):
        raise RecordError(
            "USFM reader mapping refers to a different catalogue revision"
        )
    units = {unit for unit, _ in text.units}
    profile = {
        f"{book}.{chapter}.{verse}"
        for chapter, last in enumerate(mapping["native_profile_last_verses"], start=1)
        for verse in range(1, last + 1)
    }
    if {unit for unit in units if not unit.endswith(".title")} != profile:
        raise RecordError(
            "USFM native coordinates do not match the checked numbering profile"
        )
    _checked_offsets(text, mapping)
    anchors = _anchors(reader_book)
    links = mapping["links"]
    if not set(links).issubset(anchors) or not set(mapping["candidates"]).issubset(
        anchors
    ):
        raise RecordError("USFM reader mapping exceeds the catalogue extent")
    explicit = _link_segments(text, links, mapping)
    baselines = {
        reader: anchor for reader, anchor in anchors.items() if reader not in links
    }
    native_baselines = {f"{book}.{c}.{v}" for _, c, v in baselines.values()}
    if native_baselines & explicit or native_baselines | explicit != profile:
        raise RecordError(
            "USFM reader correspondence omits or overlaps native coordinates"
        )
    return baselines


def _linked_records(
    selected: set[str], mapping: Mapping[str, Any]
) -> tuple[list[SpanSpec], list[dict]]:
    spans, links = [], []
    for reader, link in mapping["links"].items():
        segments = tuple(tuple(segment) for segment in link["segments"])
        scope = {unit for unit, _, _ in segments} or {link["scope_unit"]}
        if not scope & selected:
            continue
        if not scope.issubset(selected):
            raise ReaderBoundaryError(reader)
        key = f"{reader}:numbered_text"
        evidence = {"finding": link["finding"], "method": METHOD}
        if segments:
            spans.append(
                SpanSpec(key, "numbered_text", reader, segments, "extracted", evidence)
            )
        links.append(
            dict(
                key=key,
                has_span=bool(segments),
                reader_ref=reader,
                role="numbered_text",
                ordinal=0,
                status=("composite" if len(segments) > 1 else "exact")
                if segments
                else "missing",
                basis_json=evidence,
                gap_reason=None if segments else link["gap_reason"],
            )
        )
    return spans, links


def prepare_reader(
    identity: SourceIdentity,
    book: str,
    text: NativeText,
    selected: NativeText,
    mapping: Mapping[str, Any],
    native_scheme: str,
    source_basis: str,
) -> RecordSet:
    anchors = checked_anchors(book, text, mapping)
    unit_ids = [unit for unit, _ in selected.units]
    scope = set(unit_ids)
    baselines = [
        anchor
        for anchor in anchors.values()
        if f"{book}.{anchor[1]}.{anchor[2]}" in scope
    ]
    spans, links = _linked_records(scope, mapping)
    basis = OutputBasis(
        READER_REFERENCE,
        (identity.revision.id,),
        METHOD,
        {
            "reader_scheme_version": mapping["scheme"],
            "inventory_digest": mapping["catalogue_sha256"],
            "mapping_digest": canonical_digest(mapping),
            "source_basis": source_basis,
        },
        {"coordinate_version": selected.coordinate_version, "unit_ids": unit_ids},
    )
    return build_reader_output(
        identity,
        selected,
        basis,
        spans,
        baselines,
        links,
        native_scheme=native_scheme,
        base_evidence={
            "method": METHOD,
            "profile": mapping["profile"],
            "evidence": mapping["evidence"],
        },
    )

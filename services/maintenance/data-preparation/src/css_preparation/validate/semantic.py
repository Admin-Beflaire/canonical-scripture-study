"""Candidate-wide semantic checks against saved D1/R2 and retained native input.

Stage 4 validates storage bytes and index manifests. This module verifies exact
source wording, native coordinates, evidence endpoints and truthful coverage.
No release membership or promotion decisions are made here.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Callable, Mapping, Sequence

from ..indexes.files import PAGE_CAP
from ..indexes.english import AS_WRITTEN
from ..prepare.evidence import NativeText, OutputBasis, span_wording
from ..prepare.records import KEYS, ORDER, SHARED, RecordError, RecordSet, comparable
from .saved import CandidateInventory, SavedInventory, verify_candidate_inventory

# What a recipe rebuilds from the registered source to compare with the saved rows, if anything.
Rebuild = Callable[[Mapping[str, Any]], RecordSet] | None


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


@dataclass(frozen=True)
class SemanticEvidence:
    saved: SavedInventory
    coverage: tuple[dict[str, Any], ...]
    capabilities: tuple[str, ...]
    limitations: tuple[str, ...]


def _by_key(kind: str, rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    key = KEYS[kind]
    return sorted(rows, key=lambda row: tuple(row[k] for k in key))


def _same_as_expected(
    rows: Mapping[str, Sequence[dict[str, Any]]], expected: RecordSet, what: str
) -> None:
    """Every saved row equals the row rebuilt from the registered source; shared identities are skipped."""
    for kind in ORDER:
        if kind in SHARED:
            continue
        wanted = [comparable(kind, row) for row in expected.rows(kind)]
        if _by_key(kind, rows[kind]) != _by_key(kind, wanted):
            raise RecordError(f"Saved {kind} differs from the checked {what}")


def _posting_key(posting: dict[str, Any]) -> str:
    key = posting.get("search_key")
    if not isinstance(key, str):
        raise RecordError("Saved native posting has no search key")
    return key


def _check_index_routes(
    index: OutputBasis,
    posting_keys: set[str],
    route_rows: Sequence[dict[str, Any]],
    read_rows: Callable[[str, Sequence[str]], list[dict[str, Any]]],
) -> None:
    """A route may exclude a key only after both stored forms match the saved postings."""
    owned = [row for row in route_rows if row["output_id"] == index.output_id]
    if index.parameters.get("index_routing") != "key-output/1":
        if owned:
            raise RecordError("Unrouted index unexpectedly has routing metadata")
        return
    if len(owned) != 1:
        raise RecordError("Saved index routing differs from posting keys")
    keys = owned[0]["keys_json"]
    if len(keys) != len(posting_keys) or set(keys) != posting_keys:
        raise RecordError("Saved index routing differs from posting keys")
    expanded = read_rows("index_route_key", [index.output_id])
    if expanded != [{"output_id": index.output_id, "matched_keys": len(posting_keys)}]:
        raise RecordError("Saved indexed routing pairs differ from posting keys")


def _check_rebuilt(job, inventory, included, rows, read, kind, table, what) -> None:
    """Saved outputs of one rebuilt kind equal what the registered source rebuilds, and
    such outputs never pass without that rebuild."""
    ids = {
        basis.output_id
        for basis in (*inventory.added, *inventory.reused)
        if basis.kind == kind
    }
    if read is not None:
        expected = read(job)
        if ids != included or set(expected.output_ids()) != included:
            raise RecordError(f"Saved {what} outputs differ from the reviewed recipe")
        _same_as_expected(rows, expected, what)
    elif ids or rows[table]:
        raise RecordError(f"No registered verification for saved {what}")


def _check_expected_outputs(
    job,
    inventory,
    included,
    rows,
    read_reader_references,
    read_aid_entries,
    read_statements,
) -> set[str]:
    """Reader-reference, language-aid and statement rows equal what the registered source
    rebuilds; returns the gaps."""
    mapping_ids = {
        basis.output_id
        for basis in (*inventory.added, *inventory.reused)
        if basis.kind == "reader_reference"
    }
    gaps = set()
    if read_reader_references is not None:
        expected = read_reader_references(job)
        if mapping_ids != included or set(expected.output_ids()) != included:
            raise RecordError(
                "Saved reader-reference outputs differ from the reviewed partition"
            )
        _same_as_expected(rows, expected, "reader references")
        gaps = {
            f"{row['reader_ref']} ({row['role']}): {row['gap_reason']}"
            for row in rows["reader_reference_link"]
            if row["status"] == "missing"
        }
    elif mapping_ids or rows["reader_reference_base"] or rows["reader_reference_link"]:
        raise RecordError("No registered verification for saved reader references")
    for read, kind, table, what in (
        (read_aid_entries, "aid_entries", "aid_entry", "language-aid entries"),
        (read_statements, "character_statement", "character_statement", "statements"),
    ):
        _check_rebuilt(job, inventory, included, rows, read, kind, table, what)
    return gaps


def _read_artifact_blobs(artifacts, read_blob) -> dict[str, bytes]:
    blobs = {}
    for key, row in artifacts.items():
        try:
            data = read_blob(row["registered_locator"])
        except (KeyError, OSError) as error:
            raise RecordError(
                "Saved artifact missing during semantic validation"
            ) from error
        # The saved-inventory check performed an earlier read; fail closed if
        # an object changes between validation and semantic inspection.
        if (
            not isinstance(data, bytes)
            or len(data) != row["byte_count"]
            or hashlib.sha256(data).hexdigest() != row["sha256"]
        ):
            raise RecordError("Saved artifact changed during semantic validation")
        blobs[key] = data
    return blobs


def _cached_source(read_source) -> Callable[[str], NativeText]:
    native: dict[str, NativeText] = {}

    def source(revision: str) -> NativeText:
        if revision not in native:
            value = read_source(revision)
            if not isinstance(value, NativeText):
                raise RecordError("Registered native source could not be read")
            native[revision] = value
        return native[revision]

    return source


def _span_pieces(span, text, bases, inventory, segments) -> list[str]:
    """The source text of each segment of a span, checking coordinates and navigation rows."""
    pieces = []
    for ordinal, segment in enumerate(span["segments_json"]):
        unit = segment["unit_id"]
        body = text.unit(unit)
        start, end = segment["start"], segment["end"]
        if (
            start < 0
            or end > len(body)
            or end < start
            or unit
            not in next(
                b.extent["unit_ids"]
                for b in (*inventory.added, *inventory.reused)
                if b.output_id == span["output_id"]
            )
        ):
            raise RecordError("Saved native span exceeds its declared coordinates")
        segment_row = segments.get((span["id"], ordinal))
        expected_start = bases[unit] + start
        expected_end = bases[unit] + max(end - 1, start)
        if (
            segment_row is None
            or segment_row["start_order"] != expected_start
            or segment_row["end_order"] != expected_end
            or segment_row["source_revision_id"] != span["source_revision_id"]
            or segment_row["kind"] != span["kind"]
        ):
            raise RecordError("Saved navigation segment does not round trip to source")
        pieces.append(body[start:end])
    return pieces


def _check_native_spans(inventory, included, rows, blobs, source):
    """Saved spans and their navigation rows round trip to the registered source; returns the spans."""
    texts = {r["content_id"]: r["exact_text"] for r in rows["text_payload"]}
    spans = {r["id"]: r for r in rows["native_span"] if r["output_id"] in included}
    segments = {
        (r["span_id"], r["segment_ordinal"]): r
        for r in rows["span_segment"]
        if r["span_id"] in spans
    }
    for basis in (*inventory.added, *inventory.reused):
        if basis.kind == "evidence":
            text = source(basis.input_revisions[0])
            if text.coordinate_version != basis.extent.get("coordinate_version"):
                raise RecordError(
                    "Saved native coordinate version does not match source"
                )
    for span in spans.values():
        text = source(span["source_revision_id"])
        if text.coordinate_version != span["coordinate_version"]:
            raise RecordError("Saved native span has incompatible source coordinates")
        parent = span["parent_id"]
        if parent is not None and parent not in spans:
            raise RecordError("Saved native span has missing parent")
        pieces = _span_pieces(span, text, text.scalar_bases(), inventory, segments)
        wording = span_wording(span, texts, blobs)
        if (
            span["reading_kind"] in ("preserved", "transcribed", "extracted")
            and wording != pieces
        ):
            raise RecordError("Saved wording does not match registered native source")
        if span["reading_kind"] == "gap" and any(piece for piece in wording):
            raise RecordError("Saved gap contains wording")
    return spans


def _check_relationships(rows, included, spans) -> None:
    members_by_relation: dict[str, list[dict]] = {}
    for member in rows["relation_member"]:
        members_by_relation.setdefault(member["relationship_id"], []).append(member)
    for relation in (r for r in rows["relationship"] if r["output_id"] in included):
        members = members_by_relation.get(relation["id"], [])
        for member in members:
            endpoint = member["span_id"]
            if endpoint is not None and endpoint not in spans:
                raise RecordError("Relationship has an absent native endpoint")
        keys = [(m["role"], m["ordinal"]) for m in members]
        if len(keys) != len(set(keys)):
            raise RecordError("Relationship has duplicate ordered members")


def _posting_pieces(ref, text, index) -> list[str]:
    pieces = []
    for segment in ref["segments"]:
        body = text.unit(segment["unit_id"])
        start, end = segment["start"], segment["end"]
        if (
            start < 0
            or end > len(body)
            or end <= start
            or segment["unit_id"] not in index.extent["unit_ids"]
        ):
            raise RecordError("Saved posting is outside native source extent")
        pieces.append(body[start:end])
    return pieces


def _check_posting_line(posting, text, bases, index, spans) -> None:
    """One saved posting agrees with the registered source, its evidence span and its output."""
    ref = posting.get("native_reference")
    if (
        not isinstance(ref, dict)
        or not isinstance(ref.get("segments"), list)
        or not ref["segments"]
    ):
        raise RecordError("Saved native posting has no segments")
    pieces = _posting_pieces(ref, text, index)
    first = ref["segments"][0]
    if (
        posting["coordinate_version"] != text.coordinate_version
        or posting["native_order"] != bases[first["unit_id"]] + first["start"]
        or posting["span_id"] not in spans
    ):
        raise RecordError("Saved posting native reference disagrees with source")
    owner = spans[posting["span_id"]]
    if owner["source_revision_id"] != index.input_revisions[0]:
        raise RecordError("Saved posting span names another source")
    if not all(
        any(
            s["unit_id"] == p["unit_id"]
            and s["start"] <= p["start"]
            and p["end"] <= s["end"]
            for s in owner["segments_json"]
        )
        for p in ref["segments"]
    ):
        raise RecordError("Saved posting is outside its native evidence span")
    wording = "".join(pieces)
    if (
        index.parameters.get("normalization_rule") == AS_WRITTEN
        and posting["search_key"] != wording
    ):
        raise RecordError("Saved exact search key disagrees with source spelling")
    if posting["posting_kind"] == "word" and posting["form"] not in wording:
        raise RecordError("Saved word form disagrees with source wording")


def _check_index_postings(index, artifacts, blobs, spans, source) -> set[str]:
    """Check every saved posting of one index output; returns its search keys."""
    text = source(index.input_revisions[0])
    bases = text.scalar_bases()
    posting_keys: set[str] = set()
    for artifact in (
        r
        for r in artifacts.values()
        if r["output_id"] == index.output_id and r["format"] == "application/x-ndjson"
    ):
        for line in blobs[artifact["id"]].splitlines():
            try:
                posting = json.loads(line)
            except (ValueError, UnicodeError) as error:
                raise RecordError("Saved native posting is malformed") from error
            if not isinstance(posting, dict):
                raise RecordError("Saved native posting is not an object")
            posting_keys.add(_posting_key(posting))
            _check_posting_line(posting, text, bases, index, spans)
    return posting_keys


def _check_required_coverage(job, coverage) -> list[str]:
    """Every required capability covers the whole requested scope; returns the available capabilities."""
    required_units = job["native_extent"].get("unit_ids")
    if not isinstance(required_units, list) or not required_units:
        raise RecordError("Quality job requires explicit native unit scope")
    for capability in job["required_capabilities"]:
        actual_units = set()
        for row in coverage:
            if row["capability"] == capability and row["state"] == "available":
                actual_units.update(row["native_extent_json"].get("unit_ids", ()))
        if not set(required_units).issubset(actual_units):
            raise RecordError("Required capability coverage is incomplete")
    return sorted(
        {row["capability"] for row in coverage if row["state"] == "available"}
    )


def check_saved_semantics(
    job: dict[str, Any],
    inventory: CandidateInventory,
    *,
    read_rows: Callable[[str, Sequence[str]], list[dict[str, Any]]],
    read_blob: Callable[[str], bytes],
    read_source: Callable[[str], NativeText],
    max_page_bytes: int = PAGE_CAP,
    read_reader_references: Rebuild = None,
    read_aid_entries: Rebuild = None,
    read_statements: Rebuild = None,
) -> SemanticEvidence:
    """Never substitute a builder's success flag for saved candidate evidence."""
    saved = verify_candidate_inventory(
        inventory,
        read_rows=read_rows,
        read_blob=read_blob,
        max_page_bytes=max_page_bytes,
    )
    included = set(saved.output_ids)
    revisions = {
        ref["id"] for ref in job["input_refs"] if ref["kind"] == "source_revision"
    }
    if not revisions or any(
        b.input_revisions[0] not in revisions
        for b in (*inventory.added, *inventory.reused)
    ):
        raise RecordError(
            "Candidate inputs disagree with dispatched registered sources"
        )
    rows = {
        kind: [dict(row) for row in read_rows(kind, saved.output_ids)] for kind in ORDER
    }
    gaps = _check_expected_outputs(
        job,
        inventory,
        included,
        rows,
        read_reader_references,
        read_aid_entries,
        read_statements,
    )
    artifacts = {r["id"]: r for r in rows["artifact"] if r["output_id"] in included}
    blobs = _read_artifact_blobs(artifacts, read_blob)
    source = _cached_source(read_source)
    spans = _check_native_spans(inventory, included, rows, blobs, source)
    _check_relationships(rows, included, spans)
    for index in (
        b
        for b in (*inventory.added, *inventory.reused)
        if b.kind in ("source_search", "word_index")
    ):
        posting_keys = _check_index_postings(index, artifacts, blobs, spans, source)
        _check_index_routes(index, posting_keys, rows["index_route"], read_rows)
    coverage = tuple(
        sorted(
            (dict(row) for row in rows["coverage"] if row["output_id"] in included),
            key=lambda row: (
                row["output_id"],
                row["source_revision_id"],
                row["capability"],
            ),
        )
    )
    covered_capabilities = _check_required_coverage(job, coverage)
    limitations = tuple(
        sorted(
            gaps
            | {
                row["limitation"]
                for row in coverage
                if row["state"] != "available" and row["limitation"]
            }
        )
    )
    return SemanticEvidence(saved, coverage, tuple(covered_capabilities), limitations)

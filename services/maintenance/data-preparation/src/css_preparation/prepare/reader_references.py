"""Shared reader correspondence and saved-output manifest records."""

from __future__ import annotations

import hashlib
import json

from .evidence import (
    NativeText,
    OutputBasis,
    SourceIdentity,
    SpanSpec,
    build_evidence,
    canonical_digest,
    span_id,
)
from .records import D1_BATCH_LIMIT, RecordError, RecordSet
from ..validation import SCHEMAS

READER_REFERENCE = "reader_reference"
Anchor = tuple[str, int, int]


def reader_catalogue(book: str) -> tuple[dict, dict]:
    catalogue = json.loads(
        (SCHEMAS / "reader-references/nrsva-1.json").read_text(encoding="utf-8")
    )
    books = [
        row
        for row in catalogue["books"]
        if book == row["book_id"] or book in row["aliases"]
    ]
    if len(books) != 1:
        raise RecordError(f"Book {book} does not identify one NRSVA catalogue book")
    return catalogue, books[0]


def checked_ranges(anchors: list[Anchor]) -> list[dict]:
    ranges: list[dict] = []
    for book, chapter, verse in sorted(anchors):
        if (
            ranges
            and ranges[-1]["book_id"] == book
            and ranges[-1]["chapter"] == chapter
            and ranges[-1]["last_verse"] + 1 == verse
        ):
            ranges[-1]["last_verse"] = verse
        else:
            ranges.append(
                {
                    "book_id": book,
                    "chapter": chapter,
                    "first_verse": verse,
                    "last_verse": verse,
                }
            )
    return ranges


def build_reader_output(
    identity: SourceIdentity,
    text: NativeText,
    basis: OutputBasis,
    spans: list[SpanSpec],
    baselines: list[Anchor],
    links: list[dict],
    *,
    native_scheme: str,
    base_evidence: dict,
    literary_span_count: int = 0,
) -> RecordSet:
    version = basis.parameters["reader_scheme_version"]
    records = build_evidence(
        identity, text, spans, basis, d1_body_max_bytes=0, source_context_coverage=False
    )
    output_id = basis.output_id
    common = dict(
        output_id=output_id,
        source_revision_id=identity.revision.id,
        reader_scheme_version=version,
    )
    if baselines:
        records.add(
            "reader_reference_base",
            dict(
                **common,
                id=f"{output_id}:base",
                native_scheme_version=native_scheme,
                checked_extent_json={"ranges": checked_ranges(baselines)},
                basis_json=base_evidence,
            ),
        )
    for link in links:
        key, has_span = link["key"], link["has_span"]
        fields = {
            name: value
            for name, value in link.items()
            if name not in ("key", "has_span")
        }
        records.add(
            "reader_reference_link",
            dict(
                **common,
                **fields,
                id=f"{output_id}:{key}",
                span_id=span_id(output_id, key) if has_span else None,
            ),
        )
    # Control discovers prepared outputs through artifact refs, including
    # baseline-only outputs with no wording artifact.
    link_rows = records.rows("reader_reference_link")
    manifest = {
        "version": "reader-reference-manifest/1",
        "output_id": output_id,
        "reader_scheme_version": version,
        "checked_native_units": basis.extent["unit_ids"],
        "baseline_anchor_count": len(baselines),
        "explicit_link_count": len(link_rows),
        "gaps": [
            {
                "reader_ref": row["reader_ref"],
                "role": row["role"],
                "reason": row["gap_reason"],
            }
            for row in link_rows
            if row["status"] == "missing"
        ],
        "literary_span_count": literary_span_count,
        "rows_digest": canonical_digest(
            {
                "baseline": records.rows("reader_reference_base"),
                "links": link_rows,
                "spans": records.rows("native_span"),
            }
        ),
    }
    payload = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    artifact_id = f"{output_id}:reader-manifest"
    records.add(
        "artifact",
        {
            "id": artifact_id,
            "source_revision_id": identity.revision.id,
            "output_id": output_id,
            "sha256": digest,
            "byte_count": len(payload),
            "format": "application/json",
            "registered_locator": f"prepared/{digest}.json",
        },
    )
    records.add_blob(artifact_id, payload)
    # An explicit gap counts as a classified reference. Source wording coverage
    # remains a separate capability.
    records.add(
        "coverage",
        {
            "output_id": output_id,
            "source_revision_id": identity.revision.id,
            "method_version": basis.method_version,
            "capability": READER_REFERENCE,
            "state": "available",
            "native_extent_json": basis.extent,
            "index_artifact_id": artifact_id,
            "dependencies_json": [],
            "limitation": None,
        },
    )
    if len(records.statements()) > D1_BATCH_LIMIT:
        raise RecordError("Reader-reference unit exceeds one D1 batch")
    return records

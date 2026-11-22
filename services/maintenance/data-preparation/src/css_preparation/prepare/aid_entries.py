"""Language-aid entries as one R2 entries file per output and one small D1 row per entry.

Every line of the entries file holds one entry: its metadata, its coordinates in the
partition's native text and its wording. The D1 row holds only the lookup keys and the
line's position and digest, so Study finds an entry in D1 and reads and verifies its line
in R2. The same builder runs in preparation and again in quality, which compares what is
saved with what it builds from the source.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Mapping, Sequence

from .evidence import OutputBasis, SourceIdentity, span_id
from .records import RecordError, RecordSet

FORMAT = "application/x-ndjson; profile=aid-entries"
LOOKUP_FIELD = {
    "lexicon_entry": "strong_base",
    "grammar_expansion": "code",
    "proper_name": "disambiguated_strong",
}


def lookup_key(kind: str, details: Mapping[str, Any]) -> str | None:
    """The key an entry is found by (Strong base, grammar code or name tag); none if it has no such key."""
    value = details.get(LOOKUP_FIELD[kind])
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class AidLine:
    """One entry as stored: wording and coordinates are in the partition's native text."""

    entry_id: str
    work: str
    details: Mapping[str, Any]
    text: str
    unit: str
    start: int
    end: int


def _bytes(value: Mapping[str, Any]) -> bytes:
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise RecordError("Aid entry cannot be encoded losslessly") from error


def build_aid_records(
    source: SourceIdentity,
    basis: OutputBasis,
    *,
    kind: str,
    lines: Sequence[AidLine],
    capability: str,
) -> RecordSet:
    """The output, its entries file, one D1 row per entry and its coverage."""
    revision = source.revision.id
    if (
        kind not in LOOKUP_FIELD
        or basis.kind != "aid_entries"
        or basis.input_revisions[:1] != (revision,)
    ):
        raise RecordError("Aid output basis does not match its source or kind")
    if not lines:
        raise RecordError("An aid output needs at least one entry")
    records = RecordSet()
    for row in source.rows():
        records.add("source_node", row)
    output_id = basis.output_id
    records.add("prepared_output", basis.row())
    body, rows, offset = bytearray(), [], 0
    for entry, line in enumerate(lines):
        data = _bytes(
            {
                "basis": {"source": revision, "work": line.work},
                "details": dict(line.details),
                "entry": entry,
                "label": line.entry_id,
                "native_order": entry,
                "provider": source.attribution,
                "reading_kind": "extracted" if line.text else "gap",
                "segments": [
                    {"unit_id": line.unit, "start": line.start, "end": line.end}
                ],
                "span_id": span_id(output_id, f"entry{entry:04d}"),
                "text": line.text or None,
            }
        )
        rows.append(
            {
                "output_id": output_id,
                "entry": entry,
                "kind": kind,
                "entry_key": line.details["entry_key"],
                "lookup_key": lookup_key(kind, line.details),
                "byte_offset": offset,
                "byte_length": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        body += data
        offset += len(data)
    digest = hashlib.sha256(body).hexdigest()
    artifact = f"{output_id}:entries"
    records.add(
        "artifact",
        {
            "id": artifact,
            "source_revision_id": revision,
            "output_id": output_id,
            "sha256": digest,
            "byte_count": len(body),
            "format": FORMAT,
            "registered_locator": f"prepared/{digest}/aid-entries.ndjson",
        },
    )
    records.add_blob(artifact, bytes(body))
    for row in rows:
        records.add("aid_entry", row)
    records.add(
        "coverage",
        {
            "output_id": output_id,
            "source_revision_id": revision,
            "native_extent_json": {"unit_ids": list(basis.extent["unit_ids"])},
            "capability": capability,
            "state": "available",
            "method_version": basis.method_version,
            "index_artifact_id": artifact,
            "dependencies_json": [],
            "limitation": None,
        },
    )
    return records

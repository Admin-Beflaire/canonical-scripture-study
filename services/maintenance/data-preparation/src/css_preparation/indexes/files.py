"""Immutable, line-aligned UTF-8 NDJSON search artifacts for private R2; no I/O."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re

from ..prepare.records import RecordError, RecordSet
from ..validation import SchemaSubset
from .limits import PAGE_CAP
from .source import SourcePartition
from .word import WordPartition

_MANIFEST = SchemaSubset("indexes/manifest.v2.schema.json")
_POSTING = SchemaSubset("indexes/posting.v1.schema.json")
_DIRECTORY = SchemaSubset("indexes/directory-entry.v2.schema.json")
_SAFE_MAX = 2**53 - 1

MANIFEST_VERSION = "index-manifest/2"
POSTINGS_FORMAT = "application/x-ndjson"
DIRECTORY_FORMAT = "application/x-ndjson; profile=index-directory"


@dataclass(frozen=True)
class IndexFiles:
    manifest: dict
    records: RecordSet
    postings_artifact_id: str
    manifest_artifact_id: str
    directory_artifact_id: str


def page_lines(lines, cap: int) -> tuple[bytes, list[dict]]:
    """Pack (first_key, last_key, line) items into line-aligned pages of at most `cap` bytes."""
    complete, page, pages = bytearray(), bytearray(), []
    first = last = None
    for low, high, line in lines:
        if len(line) > cap:
            raise RecordError("Single index line exceeds encoded page cap")
        if page and len(page) + len(line) > cap:
            pages.append(
                {
                    "first_key": first,
                    "last_key": last,
                    "byte_offset": len(complete),
                    "byte_length": len(page),
                    "sha256": _sha(bytes(page)),
                }
            )
            complete.extend(page)
            page.clear()
        if not page:
            first = low
        last = high
        page.extend(line)
    if page:
        pages.append(
            {
                "first_key": first,
                "last_key": last,
                "byte_offset": len(complete),
                "byte_length": len(page),
                "sha256": _sha(bytes(page)),
            }
        )
        complete.extend(page)
    return bytes(complete), pages


def _bytes(value: dict, lf: bool = False) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise RecordError("Index JSON cannot be encoded losslessly") from error
    return encoded + (b"\n" if lf else b"")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _object_key(output_id: str, sha256: str, filename: str) -> str:
    """Portable R2 key: split immutable kind/digest identity into safe directories."""
    identity = re.fullmatch(r"(source_search|word_index):([0-9a-f]{32})", output_id)
    if identity is None:
        raise RecordError("Invalid index output identity for artifact key")
    return f"prepared/{identity[1]}/{identity[2]}/indexes/{sha256}/{filename}"


def _add_index_route(
    records: RecordSet, partition: SourcePartition | WordPartition
) -> None:
    """Derive the route from the complete immutable postings."""
    if partition.basis.parameters.get("index_routing") == "key-output/1":
        records.add(
            "index_route",
            {
                "output_id": partition.basis.output_id,
                "keys_json": sorted(
                    {row["search_key"] for row in partition.postings},
                    key=lambda key: key.encode("utf-8"),
                ),
            },
        )


@dataclass(frozen=True)
class _Stored:
    """One immutable artifact of an index: bytes, digest, name and format (a directory also its pages)."""

    id: str
    data: bytes
    sha256: str
    filename: str
    format: str
    pages: tuple = ()


_CAPABILITY = {"form": "form_exact", "lemma": "lemma_exact", "grammar": "grammar_exact"}


def _checked_partition(partition, encoded_page_cap_bytes):
    """Validate the partition and its immutable basis; return what the build needs."""
    if (
        type(encoded_page_cap_bytes) is not int
        or not 1 <= encoded_page_cap_bytes <= _SAFE_MAX
    ):
        raise RecordError("Encoded page cap must be a positive safe integer")
    if not isinstance(partition, (SourcePartition, WordPartition)):
        raise RecordError("Expected a source or word posting partition")
    word = isinstance(partition, WordPartition)
    basis = partition.basis
    if (
        basis.kind != ("word_index" if word else "source_search")
        or not basis.input_revisions
    ):
        raise RecordError("Invalid index output identity")
    if basis.parameters.get("encoded_page_cap_bytes") != encoded_page_cap_bytes:
        raise RecordError("Encoded page cap differs from immutable output basis")
    if (word and len(basis.input_revisions) < 2) or (
        not word and len(basis.input_revisions) != 1
    ):
        raise RecordError("Incompatible source or analysis revisions")
    units = basis.extent.get("unit_ids")
    coord = basis.extent.get("coordinate_version")
    if (
        not isinstance(units, list)
        or not units
        or any(not isinstance(u, str) or not u for u in units)
        or len(set(units)) != len(units)
        or not isinstance(coord, str)
        or not coord
    ):
        raise RecordError("Invalid native extent")
    if any(
        not isinstance(basis.parameters.get(name), str) or not basis.parameters[name]
        for name in ("normalization_rule", "tokenizer_version")
    ):
        raise RecordError("Missing named normalization/tokenizer rule")
    order_range = partition.order_range
    if (
        not isinstance(order_range, tuple)
        or len(order_range) != 2
        or any(type(v) is not int or not 0 <= v <= _SAFE_MAX for v in order_range)
        or order_range[0] > order_range[1]
    ):
        raise RecordError("Invalid native order range")
    if partition.coverage_state not in ("available", "partial") or (
        partition.coverage_state == "partial"
    ) != bool(partition.limitation):
        raise RecordError("Inconsistent coverage state or limitation")
    return word, basis, units, coord, order_range


def _check_posting(row, word, basis, coord, units, order_range):
    """One posting must be schema-valid and belong to this output's source and extent."""
    errors = _POSTING.document_errors(row)
    if errors:
        raise RecordError("Invalid index posting: " + "; ".join(errors[:3]))
    if (
        row["posting_kind"] != ("word" if word else "source")
        or row["source_revision_id"] != basis.input_revisions[0]
        or row["coordinate_version"] != coord
        or row["native_reference"]["source_revision_id"] != row["source_revision_id"]
        or row["native_reference"]["coordinate_version"] != coord
        or any(
            segment["unit_id"] not in units
            for segment in row["native_reference"]["segments"]
        )
        or not order_range[0] <= row["native_order"] <= order_range[1]
    ):
        raise RecordError("Index posting identity or native extent mismatch")


def _word_capability(row, basis):
    """The capability a word posting provides; its analyses must be recorded revisions."""
    if any(
        a["analysis_revision_id"] not in basis.input_revisions[1:]
        for a in row["analyses"]
    ):
        raise RecordError("Unrecorded analysis revision")
    return _CAPABILITY[row["lookup_kind"]]


def _posting_lines(partition, word, basis, coord, units, order_range):
    """Check every posting and return its lines with the capabilities it provides."""
    lines: list[tuple[str, str, bytes]] = []
    prior: tuple[bytes, int, bytes] | None = None
    seen: set[tuple[str, str]] = set()
    capabilities: set[str] = set()
    for row in partition.postings:
        _check_posting(row, word, basis, coord, units, order_range)
        order = (
            row["search_key"].encode("utf-8"),
            row["native_order"],
            row["occurrence_id"].encode("utf-8"),
        )
        if prior is not None and order < prior:
            raise RecordError("Index postings not in bytewise key/native order")
        prior = order
        pair = (row["search_key"], row["occurrence_id"])
        if pair in seen:
            raise RecordError("Duplicate index key/occurrence")
        seen.add(pair)
        if word:
            capabilities.add(_word_capability(row, basis))
        lines.append((row["search_key"], row["search_key"], _bytes(row, lf=True)))
    if not lines:
        raise RecordError("Cannot register index with no postings")
    return lines, capabilities


def _stored_pages(output_id, lines, cap):
    """Page the postings and the directory that lists their pages."""
    content, pages = page_lines(lines, cap)
    digest = _sha(content)
    posting_id = f"{output_id}:postings:{digest[:20]}"
    entries = [{"postings_artifact_id": posting_id, **page} for page in pages]
    for entry in entries:
        errors = _DIRECTORY.document_errors(entry)
        if errors:
            raise RecordError("Invalid directory entry: " + "; ".join(errors[:3]))
    # A directory page's key range spans the key ranges of the postings pages it lists.
    directory, directory_pages = page_lines(
        [
            (entry["first_key"], entry["last_key"], _bytes(entry, lf=True))
            for entry in entries
        ],
        cap,
    )
    directory_digest = _sha(directory)
    directory_id = f"{output_id}:directory:{directory_digest[:20]}"
    return (
        _Stored(posting_id, content, digest, "postings.ndjson", POSTINGS_FORMAT),
        _Stored(
            directory_id,
            directory,
            directory_digest,
            "directory.ndjson",
            DIRECTORY_FORMAT,
            tuple(directory_pages),
        ),
    )


def _manifest_file(
    partition, word, basis, coord, units, order_range, capabilities, stored, cap
):
    """Build, check and encode the manifest that names the postings and directory."""
    postings, directory = stored
    manifest = {
        "format_version": MANIFEST_VERSION,
        "index_kind": "word_language" if word else "source_text",
        "prepared_output_id": basis.output_id,
        "source_revision_ids": [basis.input_revisions[0]],
        "native_extent": {"unit_ids": list(units), "order_range": list(order_range)},
        "coordinate_version": coord,
        "normalization_rule": basis.parameters["normalization_rule"],
        "tokenizer_version": basis.parameters["tokenizer_version"],
        "analysis_revision_ids": list(basis.input_revisions[1:]) if word else [],
        "parameters": dict(basis.parameters),
        "ordering": ["search_key", "native_order", "occurrence_id"],
        "key_collation": "utf8-bytewise",
        "encoded_page_cap_bytes": cap,
        "files": [
            {
                "artifact_id": postings.id,
                "byte_length": len(postings.data),
                "sha256": postings.sha256,
            }
        ],
        "directory": {
            "artifact_id": directory.id,
            "byte_length": len(directory.data),
            "sha256": directory.sha256,
            "pages": list(directory.pages),
        },
        "coverage": {
            "capabilities": sorted(capabilities) if word else ["word_exact"],
            "state": partition.coverage_state,
            "limitation": partition.limitation,
        },
    }
    errors = _MANIFEST.document_errors(manifest)
    if errors:
        raise RecordError("Invalid index manifest: " + "; ".join(errors[:4]))
    content = _bytes(manifest)
    if len(content) > cap:
        raise RecordError(
            "Index manifest exceeds the page cap; the recipe must use smaller partitions"
        )
    digest = _sha(content)
    manifest_id = f"{basis.output_id}:manifest:{digest[:20]}"
    return manifest, _Stored(
        manifest_id, content, digest, "manifest.json", "application/json"
    )


def _index_records(partition, basis, units, order_range, manifest, stored):
    """The candidate records and blobs for one index; nothing is persisted."""
    output_id = basis.output_id
    records = RecordSet()
    records.add("prepared_output", basis.row())
    _add_index_route(records, partition)
    for item in stored:
        records.add(
            "artifact",
            {
                "id": item.id,
                "source_revision_id": basis.input_revisions[0],
                "output_id": output_id,
                "sha256": item.sha256,
                "byte_count": len(item.data),
                "format": item.format,
                "registered_locator": _object_key(
                    output_id, item.sha256, item.filename
                ),
            },
        )
        records.add_blob(item.id, item.data)
    for capability in manifest["coverage"]["capabilities"]:
        records.add(
            "coverage",
            {
                "output_id": output_id,
                "source_revision_id": basis.input_revisions[0],
                "native_extent_json": {
                    "unit_ids": list(units),
                    "order_range": list(order_range),
                },
                "capability": capability,
                "state": partition.coverage_state,
                "method_version": basis.method_version,
                "index_artifact_id": stored[-1].id,
                "dependencies_json": sorted(basis.dependencies),
                "limitation": partition.limitation,
            },
        )
    return records


def build_index_files(
    partition: SourcePartition | WordPartition,
    *,
    encoded_page_cap_bytes: int = PAGE_CAP,
) -> IndexFiles:
    """Turn one bounded source/word partition into postings, a paged directory and a manifest.

    A common search key may continue across pages. The manifest lists only directory pages
    and must itself fit the page cap; a larger partition must be split by its recipe. The
    returned RecordSet contains candidate records and blobs, but does not persist or promote them.
    """
    cap = encoded_page_cap_bytes
    word, basis, units, coord, order_range = _checked_partition(partition, cap)
    lines, capabilities = _posting_lines(
        partition, word, basis, coord, units, order_range
    )
    stored = _stored_pages(basis.output_id, lines, cap)
    manifest, manifest_file = _manifest_file(
        partition, word, basis, coord, units, order_range, capabilities, stored, cap
    )
    records = _index_records(
        partition, basis, units, order_range, manifest, (*stored, manifest_file)
    )
    postings, directory = stored
    return IndexFiles(manifest, records, postings.id, manifest_file.id, directory.id)

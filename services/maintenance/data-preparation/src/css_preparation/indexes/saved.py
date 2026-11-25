"""Saved index integrity and dependency-scoped reuse; no provider or release operations.

Verify the bytes fetched for registered private-R2 artifacts, not only their
metadata. The caller supplies the intended output bases and independently
verified, still-in-scope upstream dependencies.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Iterable, Mapping

from ..prepare.evidence import OutputBasis, reusable
from ..prepare.records import RecordError
from ..validation import SchemaSubset
from .files import (
    DIRECTORY_FORMAT,
    MANIFEST_VERSION,
    PAGE_CAP,
    POSTINGS_FORMAT,
    _bytes,
    _object_key,
)

_MANIFEST = SchemaSubset("indexes/manifest.v2.schema.json")
_POSTING = SchemaSubset("indexes/posting.v1.schema.json")
_DIRECTORY = SchemaSubset("indexes/directory-entry.v2.schema.json")
_FILENAMES = {
    "application/json": "manifest.json",
    POSTINGS_FORMAT: "postings.ndjson",
    DIRECTORY_FORMAT: "directory.ndjson",
}
_RECORDS = SchemaSubset("evidence-records.v1.schema.json")
_SAFE_MAX = 2**53 - 1


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _object(content: bytes, *, context: str) -> dict:
    try:
        decoded = json.loads(content.decode("utf-8", errors="strict"))
    except (ValueError, UnicodeError) as exc:
        raise RecordError(f"Invalid UTF-8/JSON in {context}") from exc
    if not isinstance(decoded, dict) or _bytes(decoded) != content:
        raise RecordError(f"Noncanonical or invalid JSON object in {context}")
    return decoded


def _checked_artifact(
    row: Mapping, blobs: Mapping[str, bytes], *, output_id: str, source_revision: str
) -> bytes:
    errors = _RECORDS.errors("artifact", dict(row))
    if errors:
        raise RecordError("Invalid saved artifact record: " + "; ".join(errors[:3]))
    if row["output_id"] != output_id or row["source_revision_id"] != source_revision:
        raise RecordError("Saved artifact identity mismatch")
    artifact_id = row["id"]
    content = blobs.get(artifact_id)
    if not isinstance(content, bytes) or len(content) != row["byte_count"]:
        raise RecordError(f"Missing or incomplete saved artifact {artifact_id}")
    if _digest(content) != row["sha256"]:
        raise RecordError(f"Saved artifact digest mismatch: {artifact_id}")
    # The Stage-3 writer uses portable, content-addressed private-R2 keys.
    if row["format"] not in _FILENAMES or row["registered_locator"] != _object_key(
        output_id, row["sha256"], _FILENAMES[row["format"]]
    ):
        raise RecordError("Saved artifact has an incompatible object key or format")
    return content


@dataclass(frozen=True)
class _Context:
    """What every check of one saved index needs to know."""

    basis: OutputBasis
    manifest: dict
    blobs: Mapping[str, bytes]
    artifact_by_id: Mapping
    cap: int
    max_page_bytes: int

    @property
    def output_id(self) -> str:
        return self.basis.output_id

    @property
    def revision(self) -> str:
        return self.basis.input_revisions[0]

    @property
    def word(self) -> bool:
        return self.basis.kind == "word_index"


class _Walk:
    """What the postings walk observed, checked afterwards against the manifest."""

    def __init__(self) -> None:
        self.seen: set[tuple[str, str]] = set()
        self.page_orders: dict[tuple[str, int], list[tuple[bytes, int, bytes]]] = {}
        self.capabilities: set[str] = set()
        # Source rows have one stored occurrence per normalized key. Word rows
        # carry all attributed alternatives even when several lookup keys match.
        self.observed: dict[str, set[str]] = {}


def _registered_rows(
    basis: OutputBasis, artifacts: Iterable[Mapping], coverage: Iterable[Mapping]
) -> tuple[dict, dict, str]:
    """The registered artifacts and coverage rows of this output, and the manifest's ID."""
    output_id = basis.output_id
    indexed = [dict(row) for row in artifacts if row.get("output_id") == output_id]
    covered = [dict(row) for row in coverage if row.get("output_id") == output_id]
    if not indexed or not covered:
        raise RecordError("Saved index has incomplete artifact or coverage records")
    artifact_by_id = {row.get("id"): row for row in indexed}
    if len(artifact_by_id) != len(indexed):
        raise RecordError("Duplicate saved artifact identity")
    capability_rows = {row.get("capability"): row for row in covered}
    if len(capability_rows) != len(covered):
        raise RecordError("Duplicate saved coverage capability")
    for row in covered:
        errors = _RECORDS.errors("coverage", row)
        if errors:
            raise RecordError("Invalid saved coverage: " + "; ".join(errors[:3]))
    manifest_ids = {row["index_artifact_id"] for row in covered}
    if len(manifest_ids) != 1 or None in manifest_ids:
        raise RecordError("Missing or conflicting manifest artifact reference")
    manifest_id = next(iter(manifest_ids))
    if manifest_id not in artifact_by_id:
        raise RecordError("Saved manifest is not registered")
    if artifact_by_id[manifest_id].get("format") != "application/json":
        raise RecordError("Invalid manifest artifact format")
    return artifact_by_id, capability_rows, manifest_id


def _checked_manifest(basis: OutputBasis, manifest_bytes: bytes) -> dict:
    """The manifest, when it matches the complete reuse basis."""
    manifest = _object(manifest_bytes, context="manifest")
    errors = _MANIFEST.document_errors(manifest)
    if errors:
        raise RecordError("Invalid saved index manifest: " + "; ".join(errors[:3]))
    word = basis.kind == "word_index"
    if (
        basis.kind not in ("source_search", "word_index")
        or manifest["prepared_output_id"] != basis.output_id
        or manifest["index_kind"] != ("word_language" if word else "source_text")
        or manifest["source_revision_ids"] != [basis.input_revisions[0]]
        or manifest["analysis_revision_ids"]
        != (list(basis.input_revisions[1:]) if word else [])
        or manifest["format_version"] != MANIFEST_VERSION
        or manifest["native_extent"]["unit_ids"] != basis.extent.get("unit_ids")
        or manifest["native_extent"]["order_range"][0]
        > manifest["native_extent"]["order_range"][1]
        or manifest["coordinate_version"] != basis.extent.get("coordinate_version")
        or manifest["parameters"] != dict(basis.parameters)
        or manifest["tokenizer_version"] != basis.parameters.get("tokenizer_version")
        or manifest["normalization_rule"] != basis.parameters.get("normalization_rule")
    ):
        raise RecordError(
            "Saved index manifest does not match its complete reuse basis"
        )
    return manifest


def _checked_cap(
    manifest: dict, manifest_bytes: bytes, basis: OutputBasis, max_page_bytes: int
) -> int:
    cap = manifest["encoded_page_cap_bytes"]
    if (
        cap != basis.parameters.get("encoded_page_cap_bytes")
        or cap > max_page_bytes
        or len(manifest_bytes) > cap
    ):
        raise RecordError(
            "Saved index page cap disagrees with reuse basis or configured limit"
        )
    return cap


def _check_coverage(
    basis: OutputBasis, manifest: dict, capability_rows: dict, manifest_id: str
) -> None:
    """Only complete coverage that agrees with the manifest can be reused."""
    state = manifest["coverage"]["state"]
    if state != "available" or manifest["coverage"]["limitation"] is not None:
        raise RecordError("Incomplete saved index coverage cannot be reused")
    if set(capability_rows) != set(manifest["coverage"]["capabilities"]):
        raise RecordError("Saved index coverage capabilities disagree with manifest")
    for capability, row in capability_rows.items():
        if (
            row["output_id"] != basis.output_id
            or row["source_revision_id"] != basis.input_revisions[0]
            or row["method_version"] != basis.method_version
            or row["native_extent_json"] != manifest["native_extent"]
            or row["state"] != state
            or row["limitation"] != manifest["coverage"]["limitation"]
            or row["dependencies_json"] != sorted(basis.dependencies)
            or row["index_artifact_id"] != manifest_id
        ):
            raise RecordError(f"Incompatible saved coverage: {capability}")


def _check_inventory(manifest: dict, artifact_by_id: Mapping, manifest_id: str) -> None:
    file_ids = [file["artifact_id"] for file in manifest["files"]]
    directory_id = manifest["directory"]["artifact_id"]
    if (
        len(set(file_ids)) != len(file_ids)
        or directory_id in file_ids
        or directory_id == manifest_id
        or set(artifact_by_id) != set(file_ids) | {manifest_id, directory_id}
    ):
        raise RecordError("Saved artifact inventory is incomplete or incompatible")


def _check_posting(
    posting: dict, ctx: _Context, walk: _Walk, location: tuple[str, int]
) -> str:
    """Check one decoded posting, record what it shows, and return its search key."""
    errors = _POSTING.document_errors(posting)
    if errors:
        raise RecordError("Invalid saved posting: " + "; ".join(errors[:3]))
    manifest = ctx.manifest
    order_low, order_high = manifest["native_extent"]["order_range"]
    if (
        posting["posting_kind"] != ("word" if ctx.word else "source")
        or posting["source_revision_id"] != ctx.revision
        or posting["coordinate_version"] != manifest["coordinate_version"]
        or posting["native_reference"]["source_revision_id"] != ctx.revision
        or posting["native_reference"]["coordinate_version"]
        != manifest["coordinate_version"]
        or any(
            seg["unit_id"] not in manifest["native_extent"]["unit_ids"]
            for seg in posting["native_reference"]["segments"]
        )
        or not order_low <= posting["native_order"] <= order_high
    ):
        raise RecordError("Incompatible saved posting source or native reference")
    walk.page_orders.setdefault(location, []).append(
        (
            posting["search_key"].encode("utf-8"),
            posting["native_order"],
            posting["occurrence_id"].encode("utf-8"),
        )
    )
    identity = (posting["search_key"], posting["occurrence_id"])
    if identity in walk.seen:
        raise RecordError("Duplicate saved index occurrence")
    walk.seen.add(identity)
    if ctx.word:
        _check_word_posting(posting, ctx.basis, walk)
    return posting["search_key"]


def _check_word_posting(posting: dict, basis: OutputBasis, walk: _Walk) -> None:
    kind = posting["lookup_kind"]
    if not posting["search_key"].startswith(kind + ":"):
        raise RecordError("Saved word lookup key kind mismatch")
    walk.capabilities.add(
        {"form": "form_exact", "lemma": "lemma_exact", "grammar": "grammar_exact"}[kind]
    )
    if any(
        a["analysis_revision_id"] not in basis.input_revisions[1:]
        for a in posting["analyses"]
    ):
        raise RecordError("Saved word posting has an unadmitted analysis revision")
    walk.observed.setdefault(posting["occurrence_id"], set()).update(
        a["analysis_revision_id"] for a in posting["analyses"]
    )


def _check_page(
    content: bytes,
    page: dict,
    offset: int,
    ctx: _Context,
    walk: _Walk,
    artifact_id: str,
) -> int:
    """Check one directory page of a postings file; return the page's byte length."""
    length = page["byte_length"]
    if (
        type(length) is not int
        or length < 1
        or length > ctx.cap
        or length > ctx.max_page_bytes
        or page["byte_offset"] != offset
        or offset + length > len(content)
    ):
        raise RecordError("Saved page is oversized, missing or noncontiguous")
    block = content[offset : offset + length]
    if _digest(block) != page["sha256"] or not block.endswith(b"\n"):
        raise RecordError("Saved page digest or line alignment invalid")
    lines = block.split(b"\n")
    if lines[-1] != b"" or not lines[:-1] or any(not line for line in lines[:-1]):
        raise RecordError("Saved page has incomplete or blank NDJSON lines")
    keys = [
        _check_posting(
            _object(line, context="posting"),
            ctx,
            walk,
            (artifact_id, page["byte_offset"]),
        )
        for line in lines[:-1]
    ]
    if keys[0] != page["first_key"] or keys[-1] != page["last_key"]:
        raise RecordError("Saved page key boundaries do not match decoded postings")
    return length


def _check_postings_file(
    listed: dict, entries: list, ctx: _Context, walk: _Walk
) -> None:
    artifact_id = listed["artifact_id"]
    row = ctx.artifact_by_id[artifact_id]
    if row.get("format") != POSTINGS_FORMAT:
        raise RecordError("Invalid saved postings artifact format")
    content = _checked_artifact(
        row, ctx.blobs, output_id=ctx.output_id, source_revision=ctx.revision
    )
    if listed["byte_length"] != len(content) or listed["sha256"] != _digest(content):
        raise RecordError("Saved postings do not match file directory")
    offset = 0
    for page in entries:
        offset += _check_page(content, page, offset, ctx, walk, artifact_id)
    if offset != len(content):
        raise RecordError("Saved page directory does not cover entire file")


def _check_directory_order(walk: _Walk, directory_order: list) -> None:
    """Readers follow the directory, across postings files too, so order is checked in directory sequence."""
    previous: tuple[bytes, int, bytes] | None = None
    for entry in directory_order:
        for order in walk.page_orders[
            (entry["postings_artifact_id"], entry["byte_offset"])
        ]:
            if previous is not None and order < previous:
                raise RecordError(
                    "Saved postings out of bytewise order in directory sequence"
                )
            previous = order


def _check_walk(ctx: _Context, walk: _Walk) -> None:
    """What the walk saw must match what the manifest and the basis declare."""
    if not walk.seen:
        raise RecordError("Empty saved index")
    declared_capabilities = set(ctx.manifest["coverage"]["capabilities"])
    if declared_capabilities != (walk.capabilities if ctx.word else {"word_exact"}):
        raise RecordError("Saved coverage claims unsupported lookup capabilities")
    if not ctx.word:
        return
    basis = ctx.basis
    declared = basis.extent.get("analysis_occurrence_ids")
    if not isinstance(declared, dict) or set(declared) != set(
        basis.input_revisions[1:]
    ):
        raise RecordError("Saved word analysis extent is incompatible")
    for analysis_rev, occurrence_ids in declared.items():
        if not isinstance(occurrence_ids, list) or any(
            analysis_rev not in walk.observed.get(occurrence, set())
            for occurrence in occurrence_ids
        ):
            raise RecordError("Missing required saved word analyses")


def verify_saved_index(
    basis: OutputBasis,
    saved_output: Mapping,
    artifacts: Iterable[Mapping],
    coverage: Iterable[Mapping],
    blobs: Mapping[str, bytes],
    *,
    max_page_bytes: int = PAGE_CAP,
) -> dict:
    """Reject corrupt, incomplete, incompatible or out-of-budget saved indexes.

    Only 'available' coverage is eligible for reuse; partial candidate artifacts
    remain valid Stage-3 outputs but must not be mistaken for complete indexes.
    Every D1 artifact and coverage row must agree with the registered manifest.
    """
    if type(max_page_bytes) is not int or not 1 <= max_page_bytes <= _SAFE_MAX:
        raise RecordError("Invalid saved-page byte cap")
    if not reusable(saved_output, basis):
        raise RecordError(
            "Saved index reuse basis does not match requested input, method and extent"
        )
    artifact_by_id, capability_rows, manifest_id = _registered_rows(
        basis, artifacts, coverage
    )
    manifest_bytes = _checked_artifact(
        artifact_by_id[manifest_id],
        blobs,
        output_id=basis.output_id,
        source_revision=basis.input_revisions[0],
    )
    manifest = _checked_manifest(basis, manifest_bytes)
    cap = _checked_cap(manifest, manifest_bytes, basis, max_page_bytes)
    _check_coverage(basis, manifest, capability_rows, manifest_id)
    _check_inventory(manifest, artifact_by_id, manifest_id)
    ctx = _Context(basis, manifest, blobs, artifact_by_id, cap, max_page_bytes)
    entries_by_file, directory_order = _directory_entries(
        manifest,
        artifact_by_id,
        blobs,
        cap=cap,
        max_page_bytes=max_page_bytes,
        output_id=ctx.output_id,
        revision=ctx.revision,
    )
    walk = _Walk()
    for listed in manifest["files"]:
        _check_postings_file(
            listed, entries_by_file.get(listed["artifact_id"], []), ctx, walk
        )
    _check_directory_order(walk, directory_order)
    _check_walk(ctx, walk)
    return manifest


def _directory_entries(
    manifest: dict,
    artifact_by_id: Mapping,
    blobs: Mapping[str, bytes],
    *,
    cap: int,
    max_page_bytes: int,
    output_id: str,
    revision: str,
) -> tuple[dict[str, list[dict]], list[dict]]:
    """Verify the paged directory file; return its postings-page entries per postings artifact and in order."""
    listed = manifest["directory"]
    row = artifact_by_id[listed["artifact_id"]]
    if row.get("format") != DIRECTORY_FORMAT:
        raise RecordError("Invalid saved directory artifact format")
    content = _checked_artifact(
        row, blobs, output_id=output_id, source_revision=revision
    )
    if listed["byte_length"] != len(content) or listed["sha256"] != _digest(content):
        raise RecordError("Saved directory does not match the manifest")
    files = {file["artifact_id"] for file in manifest["files"]}
    by_file: dict[str, list[dict]] = {}
    ordered: list[dict] = []
    offset = 0
    previous_last: bytes | None = None
    for page in listed["pages"]:
        length = page["byte_length"]
        if (
            length > cap
            or length > max_page_bytes
            or page["byte_offset"] != offset
            or offset + length > len(content)
        ):
            raise RecordError(
                "Saved directory page is oversized, missing or noncontiguous"
            )
        block = content[offset : offset + length]
        if _digest(block) != page["sha256"] or not block.endswith(b"\n"):
            raise RecordError("Saved directory page digest or line alignment invalid")
        lines = block.split(b"\n")[:-1]
        if not lines or any(not line for line in lines):
            raise RecordError("Saved directory page has incomplete or blank lines")
        entries = []
        for line in lines:
            entry = _object(line, context="directory entry")
            errors = _DIRECTORY.document_errors(entry)
            if errors or entry["postings_artifact_id"] not in files:
                raise RecordError("Invalid saved directory entry")
            if (
                previous_last is not None
                and entry["first_key"].encode("utf-8") < previous_last
            ):
                raise RecordError("Saved directory entries out of key order")
            previous_last = entry["last_key"].encode("utf-8")
            entries.append(entry)
            ordered.append(entry)
            by_file.setdefault(entry["postings_artifact_id"], []).append(entry)
        if (
            entries[0]["first_key"] != page["first_key"]
            or entries[-1]["last_key"] != page["last_key"]
        ):
            raise RecordError(
                "Saved directory page key boundaries do not match its entries"
            )
        offset += length
    if offset != len(content) or set(by_file) != files:
        raise RecordError("Saved directory does not cover every postings file")
    return by_file, ordered

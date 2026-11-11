"""Saved index integrity and dependency-scoped reuse; no provider or release operations.

Verify the bytes fetched for registered private-R2 artifacts, not only their
metadata. The caller supplies the intended output bases and independently
verified, still-in-scope upstream dependencies.
"""
from __future__ import annotations

import hashlib
import json
from typing import Iterable, Mapping

from ..prepare.evidence import OutputBasis, reusable
from ..prepare.records import RecordError
from ..validation import SchemaSubset
from .files import DIRECTORY_FORMAT, MANIFEST_VERSION, PAGE_CAP, POSTINGS_FORMAT, _bytes, _object_key

_MANIFEST = SchemaSubset('indexes/manifest.v2.schema.json')
_POSTING = SchemaSubset('indexes/posting.v1.schema.json')
_DIRECTORY = SchemaSubset('indexes/directory-entry.v2.schema.json')
_FILENAMES = {'application/json': 'manifest.json', POSTINGS_FORMAT: 'postings.ndjson', DIRECTORY_FORMAT: 'directory.ndjson'}
_RECORDS = SchemaSubset('evidence-records.v1.schema.json')
_SAFE_MAX = 2**53 - 1


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _object(content: bytes, *, context: str) -> dict:
    try:
        decoded = json.loads(content.decode('utf-8', errors='strict'))
    except (ValueError, UnicodeError) as exc:
        raise RecordError(f'Invalid UTF-8/JSON in {context}') from exc
    if not isinstance(decoded, dict) or _bytes(decoded) != content:
        raise RecordError(f'Noncanonical or invalid JSON object in {context}')
    return decoded


def _checked_artifact(row: Mapping, blobs: Mapping[str, bytes],
                      *, output_id: str, source_revision: str) -> bytes:
    errors = _RECORDS.errors('artifact', dict(row))
    if errors:
        raise RecordError('Invalid saved artifact record: ' + '; '.join(errors[:3]))
    if row['output_id'] != output_id or row['source_revision_id'] != source_revision:
        raise RecordError('Saved artifact identity mismatch')
    artifact_id = row['id']
    content = blobs.get(artifact_id)
    if not isinstance(content, bytes) or len(content) != row['byte_count']:
        raise RecordError(f'Missing or incomplete saved artifact {artifact_id}')
    if _digest(content) != row['sha256']:
        raise RecordError(f'Saved artifact digest mismatch: {artifact_id}')
    # The Stage-3 writer uses portable, content-addressed private-R2 keys.
    if row['format'] not in _FILENAMES or row['registered_locator'] != _object_key(
            output_id, row['sha256'], _FILENAMES[row['format']]):
        raise RecordError('Saved artifact has an incompatible object key or format')
    return content


def verify_saved_index(basis: OutputBasis, saved_output: Mapping, artifacts: Iterable[Mapping],
                       coverage: Iterable[Mapping], blobs: Mapping[str, bytes], *,
                       max_page_bytes: int = PAGE_CAP) -> dict:
    """Reject corrupt, incomplete, incompatible or out-of-budget saved indexes.

    Only 'available' coverage is eligible for reuse; partial candidate artifacts
    remain valid Stage-3 outputs but must not be mistaken for complete indexes.
    Every D1 artifact and coverage row must agree with the registered manifest.
    """
    if type(max_page_bytes) is not int or not 1 <= max_page_bytes <= _SAFE_MAX:
        raise RecordError('Invalid saved-page byte cap')
    if not reusable(saved_output, basis):
        raise RecordError('Saved index reuse basis does not match requested input, method and extent')
    output_id = basis.output_id
    revision = basis.input_revisions[0]
    indexed = [dict(row) for row in artifacts if row.get('output_id') == output_id]
    covered = [dict(row) for row in coverage if row.get('output_id') == output_id]
    if not indexed or not covered:
        raise RecordError('Saved index has incomplete artifact or coverage records')
    artifact_by_id = {row.get('id'): row for row in indexed}
    if len(artifact_by_id) != len(indexed):
        raise RecordError('Duplicate saved artifact identity')
    capability_rows = {row.get('capability'): row for row in covered}
    if len(capability_rows) != len(covered):
        raise RecordError('Duplicate saved coverage capability')
    for row in covered:
        errors = _RECORDS.errors('coverage', row)
        if errors:
            raise RecordError('Invalid saved coverage: ' + '; '.join(errors[:3]))
    manifest_ids = {row['index_artifact_id'] for row in covered}
    if len(manifest_ids) != 1 or None in manifest_ids:
        raise RecordError('Missing or conflicting manifest artifact reference')
    manifest_id = next(iter(manifest_ids))
    if manifest_id not in artifact_by_id:
        raise RecordError('Saved manifest is not registered')
    if artifact_by_id[manifest_id].get('format') != 'application/json':
        raise RecordError('Invalid manifest artifact format')
    manifest_bytes = _checked_artifact(artifact_by_id[manifest_id], blobs,
                                       output_id=output_id, source_revision=revision)
    manifest = _object(manifest_bytes, context='manifest')
    errors = _MANIFEST.document_errors(manifest)
    if errors:
        raise RecordError('Invalid saved index manifest: ' + '; '.join(errors[:3]))
    word = basis.kind == 'word_index'
    if (basis.kind not in ('source_search', 'word_index')
            or manifest['prepared_output_id'] != output_id
            or manifest['index_kind'] != ('word_language' if word else 'source_text')
            or manifest['source_revision_ids'] != [revision]
            or manifest['analysis_revision_ids'] != (list(basis.input_revisions[1:]) if word else [])
            or manifest['format_version'] != MANIFEST_VERSION
            or manifest['native_extent']['unit_ids'] != basis.extent.get('unit_ids')
            or manifest['native_extent']['order_range'][0] > manifest['native_extent']['order_range'][1]
            or manifest['coordinate_version'] != basis.extent.get('coordinate_version')
            or manifest['parameters'] != dict(basis.parameters)
            or manifest['tokenizer_version'] != basis.parameters.get('tokenizer_version')
            or manifest['normalization_rule'] != basis.parameters.get('normalization_rule')):
        raise RecordError('Saved index manifest does not match its complete reuse basis')
    cap = manifest['encoded_page_cap_bytes']
    if cap != basis.parameters.get('encoded_page_cap_bytes') or cap > max_page_bytes or len(manifest_bytes) > cap:
        raise RecordError('Saved index page cap disagrees with reuse basis or configured limit')
    state = manifest['coverage']['state']
    if state != 'available' or manifest['coverage']['limitation'] is not None:
        raise RecordError('Incomplete saved index coverage cannot be reused')
    capabilities = manifest['coverage']['capabilities']
    if set(capability_rows) != set(capabilities):
        raise RecordError('Saved index coverage capabilities disagree with manifest')
    for capability, row in capability_rows.items():
        if (row['output_id'] != output_id or row['source_revision_id'] != revision
                or row['method_version'] != basis.method_version
                or row['native_extent_json'] != manifest['native_extent']
                or row['state'] != state or row['limitation'] != manifest['coverage']['limitation']
                or row['dependencies_json'] != sorted(basis.dependencies)
                or row['index_artifact_id'] != manifest_id):
            raise RecordError(f'Incompatible saved coverage: {capability}')

    file_ids = [file['artifact_id'] for file in manifest['files']]
    directory_id = manifest['directory']['artifact_id']
    if (len(set(file_ids)) != len(file_ids) or directory_id in file_ids or directory_id == manifest_id
            or set(artifact_by_id) != set(file_ids) | {manifest_id, directory_id}):
        raise RecordError('Saved artifact inventory is incomplete or incompatible')
    entries_by_file = _directory_entries(manifest, artifact_by_id, blobs, cap=cap, max_page_bytes=max_page_bytes,
                                         output_id=output_id, revision=revision)
    order_low, order_high = manifest['native_extent']['order_range']
    previous: tuple[bytes, int, bytes] | None = None
    seen: set[tuple[str, str]] = set()
    actual_capabilities: set[str] = set()
    # Source rows have one stored occurrence per normalized key. Word rows
    # carry all attributed alternatives even when several lookup keys match.
    observed: dict[str, set[str]] = {}
    for listed in manifest['files']:
        artifact_id = listed['artifact_id']
        row = artifact_by_id[artifact_id]
        if row.get('format') != POSTINGS_FORMAT:
            raise RecordError('Invalid saved postings artifact format')
        content = _checked_artifact(row, blobs, output_id=output_id, source_revision=revision)
        if listed['byte_length'] != len(content) or listed['sha256'] != _digest(content):
            raise RecordError('Saved postings do not match file directory')
        offset = 0
        for page in entries_by_file.get(artifact_id, []):
            length = page['byte_length']
            if (type(length) is not int or length < 1 or length > cap or length > max_page_bytes
                    or page['byte_offset'] != offset or offset + length > len(content)):
                raise RecordError('Saved page is oversized, missing or noncontiguous')
            block = content[offset:offset + length]
            if _digest(block) != page['sha256'] or not block.endswith(b'\n'):
                raise RecordError('Saved page digest or line alignment invalid')
            lines = block.split(b'\n')
            if lines[-1] != b'' or not lines[:-1] or any(not line for line in lines[:-1]):
                raise RecordError('Saved page has incomplete or blank NDJSON lines')
            keys: list[str] = []
            for line in lines[:-1]:
                posting = _object(line, context='posting')
                errors = _POSTING.document_errors(posting)
                if errors:
                    raise RecordError('Invalid saved posting: ' + '; '.join(errors[:3]))
                if (posting['posting_kind'] != ('word' if word else 'source')
                        or posting['source_revision_id'] != revision
                        or posting['coordinate_version'] != manifest['coordinate_version']
                        or posting['native_reference']['source_revision_id'] != revision
                        or posting['native_reference']['coordinate_version'] != manifest['coordinate_version']
                        or any(seg['unit_id'] not in manifest['native_extent']['unit_ids']
                               for seg in posting['native_reference']['segments'])
                        or not order_low <= posting['native_order'] <= order_high):
                    raise RecordError('Incompatible saved posting source or native reference')
                order = (posting['search_key'].encode('utf-8'), posting['native_order'],
                         posting['occurrence_id'].encode('utf-8'))
                if previous is not None and order < previous:
                    raise RecordError('Saved postings out of bytewise order')
                previous = order
                identity = (posting['search_key'], posting['occurrence_id'])
                if identity in seen:
                    raise RecordError('Duplicate saved index occurrence')
                seen.add(identity)
                keys.append(posting['search_key'])
                if word:
                    kind = posting['lookup_kind']
                    if not posting['search_key'].startswith(kind + ':'):
                        raise RecordError('Saved word lookup key kind mismatch')
                    actual_capabilities.add({'form': 'form_exact', 'lemma': 'lemma_exact',
                                             'grammar': 'grammar_exact'}[kind])
                    if any(a['analysis_revision_id'] not in basis.input_revisions[1:]
                           for a in posting['analyses']):
                        raise RecordError('Saved word posting has an unadmitted analysis revision')
                    observed.setdefault(posting['occurrence_id'], set()).update(
                        a['analysis_revision_id'] for a in posting['analyses'])
            if keys[0] != page['first_key'] or keys[-1] != page['last_key']:
                raise RecordError('Saved page key boundaries do not match decoded postings')
            offset += length
        if offset != len(content):
            raise RecordError('Saved page directory does not cover entire file')
    if not seen:
        raise RecordError('Empty saved index')
    if (set(capabilities) != (actual_capabilities if word else {'word_exact'})):
        raise RecordError('Saved coverage claims unsupported lookup capabilities')
    if word:
        declared = basis.extent.get('analysis_occurrence_ids')
        if not isinstance(declared, dict) or set(declared) != set(basis.input_revisions[1:]):
            raise RecordError('Saved word analysis extent is incompatible')
        for analysis_rev, occurrence_ids in declared.items():
            if not isinstance(occurrence_ids, list) or any(
                    analysis_rev not in observed.get(occurrence, set()) for occurrence in occurrence_ids):
                raise RecordError('Missing required saved word analyses')
    return manifest


def _directory_entries(manifest: dict, artifact_by_id: Mapping, blobs: Mapping[str, bytes], *, cap: int,
                       max_page_bytes: int, output_id: str, revision: str) -> dict[str, list[dict]]:
    """Verify the paged directory file and return its postings-page entries per postings artifact."""
    listed = manifest['directory']
    row = artifact_by_id[listed['artifact_id']]
    if row.get('format') != DIRECTORY_FORMAT:
        raise RecordError('Invalid saved directory artifact format')
    content = _checked_artifact(row, blobs, output_id=output_id, source_revision=revision)
    if listed['byte_length'] != len(content) or listed['sha256'] != _digest(content):
        raise RecordError('Saved directory does not match the manifest')
    files = {file['artifact_id'] for file in manifest['files']}
    by_file: dict[str, list[dict]] = {}
    offset = 0
    previous_last: bytes | None = None
    for page in listed['pages']:
        length = page['byte_length']
        if (length > cap or length > max_page_bytes or page['byte_offset'] != offset
                or offset + length > len(content)):
            raise RecordError('Saved directory page is oversized, missing or noncontiguous')
        block = content[offset:offset + length]
        if _digest(block) != page['sha256'] or not block.endswith(b'\n'):
            raise RecordError('Saved directory page digest or line alignment invalid')
        lines = block.split(b'\n')[:-1]
        if not lines or any(not line for line in lines):
            raise RecordError('Saved directory page has incomplete or blank lines')
        entries = []
        for line in lines:
            entry = _object(line, context='directory entry')
            errors = _DIRECTORY.document_errors(entry)
            if errors or entry['postings_artifact_id'] not in files:
                raise RecordError('Invalid saved directory entry')
            if previous_last is not None and entry['first_key'].encode('utf-8') < previous_last:
                raise RecordError('Saved directory entries out of key order')
            previous_last = entry['last_key'].encode('utf-8')
            entries.append(entry)
            by_file.setdefault(entry['postings_artifact_id'], []).append(entry)
        if entries[0]['first_key'] != page['first_key'] or entries[-1]['last_key'] != page['last_key']:
            raise RecordError('Saved directory page key boundaries do not match its entries')
        offset += length
    if offset != len(content) or set(by_file) != files:
        raise RecordError('Saved directory does not cover every postings file')
    return by_file


def reusable_index_ids(bases: Iterable[OutputBasis], saved_outputs: Iterable[Mapping],
                       artifacts: Iterable[Mapping], coverage: Iterable[Mapping],
                       blobs: Mapping[str, bytes], *, valid_external_dependencies: Iterable[str],
                       max_page_bytes: int = PAGE_CAP) -> tuple[str, ...]:
    """Select verified saved indexes only for the instructed target basis set.

    A missing/changed/removed upstream output invalidates its dependents. Outputs
    not requested are omitted, and unrelated saved records remain untouched.
    The caller rebuilds desired but non-reusable outputs; this function never
    rewrites records or chooses a release.
    """
    planned = tuple(bases)
    planned_ids = [basis.output_id for basis in planned]
    if len(set(planned_ids)) != len(planned_ids):
        raise RecordError('Duplicate requested index output')
    external = set(valid_external_dependencies)
    if external.intersection(planned_ids):
        raise RecordError('External dependencies must not override requested index validation')
    by_id = {row.get('id'): row for row in saved_outputs}
    all_artifacts, all_coverage = tuple(artifacts), tuple(coverage)
    kept: set[str] = set()
    pending = list(planned)
    progress = True
    while pending and progress:
        progress = False
        for basis in pending[:]:
            if not set(basis.dependencies).issubset(external | kept):
                continue
            pending.remove(basis)
            progress = True
            row = by_id.get(basis.output_id)
            if row is None:
                continue
            try:
                verify_saved_index(basis, row, all_artifacts, all_coverage, blobs,
                                   max_page_bytes=max_page_bytes)
            except RecordError:
                continue  # invalid saved object: rebuild rather than reuse
            kept.add(basis.output_id)
    return tuple(output_id for output_id in planned_ids if output_id in kept)

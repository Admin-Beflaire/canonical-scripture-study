"""Immutable, line-aligned UTF-8 NDJSON search artifacts for private R2; no I/O."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re

from ..prepare.records import RecordError, RecordSet
from ..validation import SchemaSubset
from .source import SourcePartition
from .word import WordPartition

_MANIFEST = SchemaSubset('indexes/manifest.v1.schema.json')
_POSTING = SchemaSubset('indexes/posting.v1.schema.json')
_SAFE_MAX = 2**53 - 1


@dataclass(frozen=True)
class IndexFiles:
    manifest: dict
    records: RecordSet
    postings_artifact_id: str
    manifest_artifact_id: str


def _bytes(value: dict, lf: bool = False) -> bytes:
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError) as error:
        raise RecordError('Index JSON cannot be encoded losslessly') from error
    return encoded + (b'\n' if lf else b'')


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _object_key(output_id: str, sha256: str, filename: str) -> str:
    """Portable R2 key: split immutable kind/digest identity into safe directories."""
    identity = re.fullmatch(r'(source_search|word_index):([0-9a-f]{32})', output_id)
    if identity is None:
        raise RecordError('Invalid index output identity for artifact key')
    return f'prepared/{identity[1]}/{identity[2]}/indexes/{sha256}/{filename}'


def build_index_files(partition: SourcePartition | WordPartition, *,
                      encoded_page_cap_bytes: int = 2048) -> IndexFiles:
    """Turn one bounded source/word partition into one registered file and manifest.

    A common search key may continue across pages. The returned RecordSet contains
    candidate records and blobs, but does not persist or promote them.
    """
    if type(encoded_page_cap_bytes) is not int or not 1 <= encoded_page_cap_bytes <= _SAFE_MAX:
        raise RecordError('Encoded page cap must be a positive safe integer')
    if not isinstance(partition, (SourcePartition, WordPartition)):
        raise RecordError('Expected a source or word posting partition')
    word = isinstance(partition, WordPartition)
    basis = partition.basis
    if basis.kind != ('word_index' if word else 'source_search') or not basis.input_revisions:
        raise RecordError('Invalid index output identity')
    if basis.parameters.get('encoded_page_cap_bytes') != encoded_page_cap_bytes:
        raise RecordError('Encoded page cap differs from immutable output basis')
    if (word and len(basis.input_revisions) < 2) or (not word and len(basis.input_revisions) != 1):
        raise RecordError('Incompatible source or analysis revisions')
    units = basis.extent.get('unit_ids')
    coord = basis.extent.get('coordinate_version')
    if (not isinstance(units, list) or not units or
            any(not isinstance(u, str) or not u for u in units) or len(set(units)) != len(units)
            or not isinstance(coord, str) or not coord):
        raise RecordError('Invalid native extent')
    if any(not isinstance(basis.parameters.get(name), str) or not basis.parameters[name]
           for name in ('normalization_rule', 'tokenizer_version')):
        raise RecordError('Missing named normalization/tokenizer rule')
    if (partition.coverage_state not in ('available', 'partial')
            or (partition.coverage_state == 'partial') != bool(partition.limitation)):
        raise RecordError('Inconsistent coverage state or limitation')

    complete = bytearray()
    page = bytearray()
    pages: list[dict] = []
    first: str | None = None
    last: str | None = None
    prior: tuple[bytes, int, bytes] | None = None
    seen: set[tuple[str, str]] = set()
    capabilities: set[str] = set()

    def flush() -> None:
        nonlocal first, last
        if page:
            data = bytes(page)
            pages.append({'first_key': first, 'last_key': last,
                          'byte_offset': len(complete), 'byte_length': len(data),
                          'sha256': _sha(data)})
            complete.extend(data)
            page.clear()
            first = last = None

    for row in partition.postings:
        errors = _POSTING.document_errors(row)
        if errors:
            raise RecordError('Invalid index posting: ' + '; '.join(errors[:3]))
        if (row['posting_kind'] != ('word' if word else 'source')
                or row['source_revision_id'] != basis.input_revisions[0]
                or row['coordinate_version'] != coord
                or row['native_reference']['source_revision_id'] != row['source_revision_id']
                or row['native_reference']['coordinate_version'] != coord
                or any(segment['unit_id'] not in units for segment in row['native_reference']['segments'])):
            raise RecordError('Index posting identity or native extent mismatch')
        order = (row['search_key'].encode('utf-8'), row['native_order'],
                 row['occurrence_id'].encode('utf-8'))
        if prior is not None and order < prior:
            raise RecordError('Index postings not in bytewise key/native order')
        prior = order
        pair = (row['search_key'], row['occurrence_id'])
        if pair in seen:
            raise RecordError('Duplicate index key/occurrence')
        seen.add(pair)
        if word:
            if any(a['analysis_revision_id'] not in basis.input_revisions[1:] for a in row['analyses']):
                raise RecordError('Unrecorded analysis revision')
            capabilities.add({'form': 'form_exact', 'lemma': 'lemma_exact',
                              'grammar': 'grammar_exact'}[row['lookup_kind']])
        line = _bytes(row, lf=True)
        if len(line) > encoded_page_cap_bytes:
            raise RecordError('Single posting line exceeds encoded page cap')
        if page and len(page) + len(line) > encoded_page_cap_bytes:
            flush()
        if not page:
            first = row['search_key']
        last = row['search_key']
        page.extend(line)
    flush()
    if not pages:
        raise RecordError('Cannot register index with no postings')

    content = bytes(complete)
    output_id = basis.output_id
    digest = _sha(content)
    posting_id = f'{output_id}:postings:{digest[:20]}'
    manifest = {
        'format_version': 'index-manifest/1',
        'index_kind': 'word_language' if word else 'source_text',
        'prepared_output_id': output_id,
        'source_revision_ids': [basis.input_revisions[0]],
        'native_extent': {'unit_ids': list(units)},
        'coordinate_version': coord,
        'normalization_rule': basis.parameters['normalization_rule'],
        'tokenizer_version': basis.parameters['tokenizer_version'],
        'analysis_revision_ids': list(basis.input_revisions[1:]) if word else [],
        'parameters': dict(basis.parameters),
        'ordering': ['search_key', 'native_order', 'occurrence_id'],
        'key_collation': 'utf8-bytewise',
        'encoded_page_cap_bytes': encoded_page_cap_bytes,
        'files': [{'artifact_id': posting_id, 'byte_length': len(content),
                   'sha256': digest, 'pages': pages}],
        'coverage': {'capabilities': sorted(capabilities) if word else ['word_exact'],
                     'state': partition.coverage_state, 'limitation': partition.limitation},
    }
    errors = _MANIFEST.document_errors(manifest)
    if errors:
        raise RecordError('Invalid index manifest: ' + '; '.join(errors[:4]))
    manifest_content = _bytes(manifest)
    manifest_digest = _sha(manifest_content)
    manifest_id = f'{output_id}:manifest:{manifest_digest[:20]}'
    records = RecordSet()
    records.add('prepared_output', basis.row())
    for artifact_id, data, sha, filename, kind in (
        (posting_id, content, digest, 'postings.ndjson', 'application/x-ndjson'),
        (manifest_id, manifest_content, manifest_digest, 'manifest.json', 'application/json')
    ):
        records.add('artifact', {
            'id': artifact_id, 'source_revision_id': basis.input_revisions[0],
            'output_id': output_id, 'sha256': sha, 'byte_count': len(data),
            'format': kind, 'registered_locator': _object_key(output_id, sha, filename),
        })
        records.add_blob(artifact_id, data)
    for capability in manifest['coverage']['capabilities']:
        records.add('coverage', {
            'output_id': output_id, 'source_revision_id': basis.input_revisions[0],
            'native_extent_json': {'unit_ids': list(units)},
            'capability': capability, 'state': partition.coverage_state,
            'method_version': basis.method_version, 'index_artifact_id': manifest_id,
            'dependencies_json': sorted(basis.dependencies), 'limitation': partition.limitation,
        })
    return IndexFiles(manifest, records, posting_id, manifest_id)

"""Bounded source-text posting preparation; no R2 writes or word analyses.

Adapters provide source-specific tokenizer/normalizer functions and stable version IDs.
The builder never guesses language rules or rewrites the stored native wording.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from ..prepare.evidence import NativeText, OutputBasis
from ..prepare.records import RecordError, RecordSet

MAX_SAFE_ORDER = 2**53 - 1


@dataclass(frozen=True)
class TextRules:
    tokenizer_version: str
    normalization_rule: str
    tokenize: Callable[[str], Iterable[tuple[int, int]]]
    normalize: Callable[[str], str]


@dataclass(frozen=True)
class SourcePartition:
    basis: OutputBasis
    postings: tuple[dict, ...]
    coverage_state: str
    limitation: str | None


def _partitions(text: NativeText, units: tuple[str, ...], max_units: int,
                max_scalars: int) -> Iterable[tuple[str, ...]]:
    if type(max_units) is not int or type(max_scalars) is not int or min(max_units, max_scalars) < 1:
        raise RecordError('Partition limits must be positive integers')
    group: list[str] = []
    size = 0
    for unit in units:
        length = len(text.unit(unit))
        if length > max_scalars:
            raise RecordError(f'Native unit {unit} exceeds the declared partition limit')
        if group and (len(group) == max_units or size + length > max_scalars):
            yield tuple(group)
            group, size = [], 0
        group.append(unit)
        size += length
    if group:
        yield tuple(group)


def build_source_postings(text: NativeText, evidence: RecordSet, basis: OutputBasis, rules: TextRules, *,
                          max_units: int, max_scalars: int, max_occurrences: int,
                          encoded_page_cap_bytes: int = 2048) -> tuple[SourcePartition, ...]:
    """Turn indexed native units into exact-referenced source postings, partitioned by recipe limits.

    Each partition has its own complete immutable reuse basis. Stage 3 serializes the
    postings and creates the registered files/coverage; this stage performs no I/O.
    """
    if basis.kind != 'source_search' or not basis.input_revisions or not basis.method_version:
        raise RecordError('Expected a source_search output basis with source revision and method')
    revision = basis.input_revisions[0]
    unit_ids = tuple(unit for unit, _ in text.units)
    if (basis.extent.get('coordinate_version') != text.coordinate_version or
            basis.extent.get('unit_ids') != list(unit_ids)):
        raise RecordError('Declared source extent and coordinates must match the native input')
    if not rules.tokenizer_version or not rules.normalization_rule:
        raise RecordError('Named tokenizer and normalization versions are required')
    if type(max_occurrences) is not int or max_occurrences < 1:
        raise RecordError('Occurrence limit must be a positive integer')
    if type(encoded_page_cap_bytes) is not int or not 1 <= encoded_page_cap_bytes <= MAX_SAFE_ORDER:
        raise RecordError('Encoded page cap must be a positive safe integer')
    if basis.parameters.get('tokenizer_version') != rules.tokenizer_version or basis.parameters.get('normalization_rule') != rules.normalization_rule:
        raise RecordError('Rule identities must match the recorded reuse parameters')
    if len(set(basis.dependencies)) != len(basis.dependencies):
        raise RecordError('Duplicate output dependencies')
    output_ids = set(evidence.output_ids())
    if len(output_ids) != 1 or not output_ids.issubset(set(basis.dependencies)):
        raise RecordError('Source search must depend on its single prepared evidence output')
    evidence_id = next(iter(output_ids))
    coverage = [row for row in evidence.rows('coverage')
                if row['output_id'] == evidence_id and row['source_revision_id'] == revision
                and row['capability'] == 'source_context']
    if len(coverage) != 1 or coverage[0]['state'] not in ('available', 'partial'):
        raise RecordError('Source search requires prepared retrievable source evidence')
    covered = set(coverage[0]['native_extent_json'].get('unit_ids', ()))
    if set(unit_ids) != covered:
        raise RecordError('Source search extent includes missing or unverified evidence units')
    spans = [row for row in evidence.rows('native_span') if row['output_id'] == evidence_id
             and row['source_revision_id'] == revision and row['coordinate_version'] == text.coordinate_version
             and row['reading_kind'] != 'gap']
    if not spans:
        raise RecordError('No source spans available for exact occurrence references')
    if not text.complete and not text.limitation:
        raise RecordError('Partial native text needs a limitation')
    offsets = text.scalar_bases()
    segments_by_unit: dict[str, list[tuple[int, int, int, str]]] = {}
    for span in spans:
        for ref in span['segments_json']:
            if (ref['unit_id'] in covered and
                    not 0 <= ref['start'] <= ref['end'] <= len(text.unit(ref['unit_id']))):
                raise RecordError('Span segment is outside its native unit')
            segments_by_unit.setdefault(ref['unit_id'], []).append(
                (ref['start'], ref['end'], span['native_order'], span['id']))
    results = []
    for group in _partitions(text, unit_ids, max_units, max_scalars):
        group_basis = OutputBasis('source_search', basis.input_revisions, basis.method_version,
                                  {**basis.parameters, 'partition_max_units': max_units,
                                   'partition_max_scalars': max_scalars,
                                   'partition_max_occurrences': max_occurrences,
                                   'encoded_page_cap_bytes': encoded_page_cap_bytes},
                                  {**basis.extent, 'unit_ids': list(group)}, basis.dependencies)
        postings = []
        for unit in group:
            body = text.unit(unit)
            previous_end = 0
            for segment in rules.tokenize(body):
                if (not isinstance(segment, (tuple, list)) or len(segment) != 2 or
                        any(type(x) is not int for x in segment)):
                    raise RecordError('Tokenizer returned invalid scalar offsets')
                start, end = segment
                if not previous_end <= start < end <= len(body):
                    raise RecordError('Tokenizer returned overlapping or invalid scalar offsets')
                previous_end = end
                key = rules.normalize(body[start:end])
                if not isinstance(key, str) or any(0xD800 <= ord(c) <= 0xDFFF for c in key):
                    raise RecordError('Normalizer returned invalid Unicode')
                owners = [(seg_end - seg_start, span_order, span_id)
                          for seg_start, seg_end, span_order, span_id in segments_by_unit.get(unit, ())
                          if seg_start <= start and end <= seg_end]
                if not owners:
                    raise RecordError(f'No retrievable span covers {unit}:{start}-{end}')
                order = offsets[unit] + start
                if order > MAX_SAFE_ORDER:
                    raise RecordError('Native order exceeds the declared JSON integer limit')
                postings.append({'posting_kind': 'source', 'search_key': key,
                                 'source_revision_id': revision, 'span_id': min(owners)[2],
                                 'coordinate_version': text.coordinate_version,
                                 'native_order': order, 'occurrence_id': f'{unit}:{start}:{end}',
                                 'native_reference': {'schema_version': 'native-reference/1',
                                                      'source_revision_id': revision,
                                                      'coordinate_version': text.coordinate_version,
                                                      'segments': [{'unit_id': unit, 'start': start, 'end': end}]}})
                if len(postings) > max_occurrences:
                    raise RecordError('Partition exceeds the declared occurrence limit')
        postings.sort(key=lambda row: (row['search_key'].encode('utf-8'), row['native_order'],
                                       row['occurrence_id'].encode('utf-8')))
        if len({(row['search_key'], row['occurrence_id']) for row in postings}) != len(postings):
            raise RecordError('Duplicate source occurrence')
        state = 'partial' if not text.complete or coverage[0]['state'] == 'partial' else 'available'
        results.append(SourcePartition(group_basis, tuple(postings), state,
                                       (text.limitation or coverage[0].get('limitation')) if state == 'partial' else None))
    return tuple(results)

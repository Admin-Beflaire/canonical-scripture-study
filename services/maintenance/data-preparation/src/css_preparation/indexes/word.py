"""Word, lemma and grammar postings from admitted, attributed native analyses.

Stage 2 keeps the IX-01 posting contract. Stage 3 owns page serialization and
artifact creation; this module does not read or write remote storage.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

from .limits import PAGE_CAP
from ..prepare.evidence import NativeText, OutputBasis, canonical_digest
from ..prepare.records import RecordError
from .source import SourcePartition, MAX_SAFE_ORDER


@dataclass(frozen=True)
class AnalysisAlternative:
    analysis_id: str
    analysis_revision_id: str
    lemma_id: str
    grammar: Mapping[str, str]
    provider: str
    basis: str

    def row(self) -> dict:
        return {'analysis_id': self.analysis_id, 'analysis_revision_id': self.analysis_revision_id,
                'lemma_id': self.lemma_id, 'grammar': dict(self.grammar),
                'provider': self.provider, 'basis': self.basis}


@dataclass(frozen=True)
class WordObservation:
    occurrence_id: str
    form_id: str
    form: str
    alternatives: tuple[AnalysisAlternative, ...]


@dataclass(frozen=True)
class WordPartition:
    basis: OutputBasis
    postings: tuple[dict, ...]
    coverage_state: str
    limitation: str | None
    order_range: tuple[int, int] | None = None   # inherited from its source partition


def _valid(value: str) -> bool:
    return isinstance(value, str) and bool(value) and all(not 0xD800 <= ord(c) <= 0xDFFF for c in value)


def build_word_postings(text: NativeText, source_partitions: Iterable[SourcePartition],
                        observations: Iterable[WordObservation],
                        expected_by_revision: Mapping[str, frozenset[str]],
                        admitted_analysis_revisions: tuple[str, ...], basis: OutputBasis, *,
                        normalize: Callable[[str], str],
                        grammar_keys: Callable[[AnalysisAlternative], Iterable[str]],
                        max_postings: int, encoded_page_cap_bytes: int = PAGE_CAP) -> tuple[WordPartition, ...]:
    """Build deterministic lookup rows over the exact Stage 1 occurrences.

    expected_by_revision is the admitted adapter's declared native-occurrence
    scope for each analysis revision. Missing required analyses yield partial
    coverage, never a misleading available index.
    """
    if basis.kind != 'word_index' or not basis.method_version or not basis.input_revisions:
        raise RecordError('Expected a word_index output basis')
    source_revision = basis.input_revisions[0]
    if (not admitted_analysis_revisions or len(set(admitted_analysis_revisions)) != len(admitted_analysis_revisions)
            or any(not _valid(rev) for rev in admitted_analysis_revisions)
            or basis.input_revisions != (source_revision, *admitted_analysis_revisions)
            or set(expected_by_revision) != set(admitted_analysis_revisions)):
        raise RecordError('Word basis must identify every admitted analysis revision and its declared scope')
    if (basis.extent.get('coordinate_version') != text.coordinate_version or
            basis.extent.get('unit_ids') != [unit for unit, _ in text.units]):
        raise RecordError('Word basis extent does not match the native source')
    if not _valid(basis.parameters.get('normalization_rule')) or not _valid(basis.parameters.get('tokenizer_version')) or not _valid(basis.parameters.get('grammar_key_version')):
        raise RecordError('Word lookup rules need named versions in their reuse parameters')
    if type(max_postings) is not int or max_postings < 1:
        raise RecordError('Posting limit must be a positive integer')
    if type(encoded_page_cap_bytes) is not int or not 1 <= encoded_page_cap_bytes <= MAX_SAFE_ORDER:
        raise RecordError('Encoded page cap must be a positive safe integer')

    source_parts = tuple(source_partitions)
    if not source_parts:
        raise RecordError('Word index requires source search outputs first')
    known_units = {unit_id for unit_id, _ in text.units}
    seen_units: set[str] = set()
    ordered_units: list[str] = []
    sources: dict[str, tuple[dict, SourcePartition]] = {}
    for part in source_parts:
        parent = part.basis
        if (parent.kind != 'source_search' or parent.input_revisions[0] != source_revision or
                parent.extent.get('coordinate_version') != text.coordinate_version or
                parent.parameters.get('normalization_rule') != basis.parameters['normalization_rule'] or
                parent.parameters.get('tokenizer_version') != basis.parameters['tokenizer_version']):
            raise RecordError('Incompatible source-search dependency')
        units = parent.extent.get('unit_ids')
        if not isinstance(units, list) or not units or any(u not in known_units or u in seen_units for u in units):
            raise RecordError('Overlapping or invalid source-search partition extent')
        seen_units.update(units)
        ordered_units.extend(units)
        for posting in part.postings:
            if posting['occurrence_id'] in sources:
                raise RecordError('Duplicate native occurrence across source partitions')
            if (posting['source_revision_id'] != source_revision or posting['coordinate_version'] != text.coordinate_version
                    or posting['native_reference']['source_revision_id'] != source_revision
                    or posting['native_reference']['coordinate_version'] != text.coordinate_version):
                raise RecordError('Source posting identity does not match the native source')
            sources[posting['occurrence_id']] = (posting, part)
    if ordered_units != [u for u, _ in text.units]:
        raise RecordError('Missing or out-of-order source-search partition extent')

    expected = set()
    for revision, occurrence_ids in expected_by_revision.items():
        if not isinstance(occurrence_ids, (frozenset, set)) or not occurrence_ids <= sources.keys():
            raise RecordError(f'Analysis extent for {revision} contains unknown native occurrences')
        expected.update(occurrence_ids)
    by_occurrence: dict[str, WordObservation] = {}
    for observation in observations:
        occurrence_id = observation.occurrence_id
        if occurrence_id not in expected or occurrence_id in by_occurrence:
            raise RecordError('Unrequested or duplicate word occurrence')
        if not _valid(observation.form_id) or not _valid(observation.form):
            raise RecordError('Invalid original word form identity')
        posting, _ = sources[occurrence_id]
        native = posting['native_reference']
        segments = native['segments']
        if len(segments) != 1:
            raise RecordError('Word occurrence requires a single exact native segment')
        segment = segments[0]
        actual = text.unit(segment['unit_id'])[segment['start']:segment['end']]
        if actual != observation.form:
            raise RecordError('Word form does not match exact native wording')
        if not observation.alternatives:
            raise RecordError('Word occurrence must retain its attributed analyses')
        ids: set[str] = set()
        for alternative in observation.alternatives:
            if (alternative.analysis_revision_id not in admitted_analysis_revisions
                    or occurrence_id not in expected_by_revision[alternative.analysis_revision_id]):
                raise RecordError('Undeclared or unadmitted analysis alternative')
            if (not all(_valid(v) for v in (alternative.analysis_id, alternative.lemma_id,
                                            alternative.provider, alternative.basis))
                    or not isinstance(alternative.grammar, Mapping)
                    or not all(_valid(k) and _valid(v) for k, v in alternative.grammar.items())
                    or alternative.analysis_id in ids):
                raise RecordError('Invalid or duplicate analysis identity/attribution')
            ids.add(alternative.analysis_id)
        by_occurrence[occurrence_id] = observation

    missing = {revision: expected_by_revision[revision] - {
        occ for occ, obs in by_occurrence.items()
        if any(a.analysis_revision_id == revision for a in obs.alternatives)}
        for revision in admitted_analysis_revisions}

    results = []
    for part in source_parts:
        part_ids = {posting['occurrence_id'] for posting in part.postings}
        if not part_ids & expected:
            continue  # no admitted analyses for this source extent
        rows: list[dict] = []
        for source_posting in part.postings:
            occurrence_id = source_posting['occurrence_id']
            observation = by_occurrence.get(occurrence_id)
            if observation is None:
                continue
            ordered = sorted(observation.alternatives,
                             key=lambda a: (a.analysis_revision_id.encode('utf-8'), a.analysis_id.encode('utf-8')))
            alternatives = [a.row() for a in ordered]
            normalized = normalize(observation.form)
            if not isinstance(normalized, str) or any(0xD800 <= ord(c) <= 0xDFFF for c in normalized):
                raise RecordError('Invalid normalized form search key')
            if normalized != source_posting['search_key']:
                raise RecordError('Word normalization disagrees with source index')
            keys: set[tuple[str, str]] = {('form', 'form:' + normalized)}
            for alt in ordered:
                keys.add(('lemma', 'lemma:' + alt.lemma_id))
                for key in grammar_keys(alt):
                    if not isinstance(key, str) or not key.startswith('grammar:') or not _valid(key[8:]):
                        raise RecordError('Invalid grammar lookup key')
                    keys.add(('grammar', key))
            for lookup_kind, search_key in sorted(keys):
                rows.append({**source_posting, 'posting_kind': 'word', 'search_key': search_key,
                             'lookup_kind': lookup_kind, 'form_id': observation.form_id,
                             'form': observation.form, 'analyses': alternatives})
                if len(rows) > max_postings:
                    raise RecordError('Partition exceeds declared word posting limit')
                if source_posting['native_order'] > MAX_SAFE_ORDER:
                    raise RecordError('Native order exceeds JSON integer limit')
        rows.sort(key=lambda row: (row['search_key'].encode('utf-8'), row['native_order'],
                                   row['occurrence_id'].encode('utf-8')))
        if len({(row['search_key'], row['occurrence_id']) for row in rows}) != len(rows):
            raise RecordError('Duplicate word search key/occurrence')
        missing_here = sum(len(m & part_ids) for m in missing.values())
        state = 'partial' if part.coverage_state != 'available' or missing_here else 'available'
        problems = [item for item in (part.limitation,
                    f'{missing_here} declared analysis result(s) missing' if missing_here else None) if item]
        limitation = '; '.join(problems) or None
        extent = {**part.basis.extent, 'analysis_occurrence_ids': {
            rev: sorted(expected_by_revision[rev] & part_ids, key=lambda x: x.encode('utf-8'))
            for rev in admitted_analysis_revisions}}
        # A later-arriving or corrected analysis under the same declared revision
        # must never collide with the partial/older output's immutable identity.
        received = [
            {'occurrence_id': item['occurrence_id'], 'form_id': by_occurrence[item['occurrence_id']].form_id,
             'form': by_occurrence[item['occurrence_id']].form,
             'alternatives': [a.row() for a in sorted(by_occurrence[item['occurrence_id']].alternatives,
                 key=lambda a: (a.analysis_revision_id.encode('utf-8'), a.analysis_id.encode('utf-8')))]}
            for item in part.postings if item['occurrence_id'] in by_occurrence
        ]
        word_basis = OutputBasis('word_index', basis.input_revisions, basis.method_version,
                                 {**basis.parameters, 'partition_max_postings': max_postings,
                                  'encoded_page_cap_bytes': encoded_page_cap_bytes,
                                  'received_analysis_sha256': canonical_digest(received)},
                                 extent, tuple(dict.fromkeys((*basis.dependencies, part.basis.output_id))))
        results.append(WordPartition(word_basis, tuple(rows), state, limitation if state == 'partial' else None,
                                     part.order_range))
    return tuple(results)

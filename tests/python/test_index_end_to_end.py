"""DP-03 Stage 5: synthetic native evidence through saved source/word indexes.

Exercises the approved index contracts with checked, in-memory stand-ins for D1
and private R2. No real source or provider/selection operation occurs.
"""
from dataclasses import replace
import json
import unittest

from css_shared import extract_scalar_segments
from css_preparation.indexes.files import build_index_files
from css_preparation.indexes.saved import reusable_index_ids, verify_saved_index
from css_preparation.indexes.source import build_source_postings
from css_preparation.indexes.word import (
    AnalysisAlternative, WordObservation, build_word_postings,
)
from css_preparation.prepare.evidence import NativeText, OutputBasis, SpanSpec, build_evidence
from css_preparation.prepare.literary import LiteraryUnit, literary_spans
from css_preparation.prepare.records import RecordError, RecordSet, decoded

from preparation_fixture import COORDINATES, database, identity, save
from test_source_index_builder import RULES, configured_basis

A, B = 'synthetic:analysis-a', 'synthetic:analysis-b'
PAGE_CAP = 2048
REQUEST_CAP = 4096


def _lookup(manifest, blobs, key):
    """Fixture-only byte-range enumerator: at most two pages per request."""
    matched = []
    for directory in manifest['files']:
        for page in directory['pages']:
            if page['first_key'].encode('utf-8') <= key.encode('utf-8') <= page['last_key'].encode('utf-8'):
                matched.append((directory['artifact_id'], page))
    results = []
    for start in range(0, len(matched), 2):
        batch = matched[start:start + 2]
        assert sum(page['byte_length'] for _, page in batch) <= REQUEST_CAP
        for artifact_id, page in batch:
            data = blobs[artifact_id][page['byte_offset']:page['byte_offset'] + page['byte_length']]
            for line in data.splitlines():
                row = json.loads(line.decode('utf-8'))
                if row['search_key'] == key:
                    results.append(row)
    return matched, results


class IndexIntegratedStageFive(unittest.TestCase):
    def setUp(self):
        self.source = identity('integrated')
        # Each alef has a point that search normalization deliberately removes.
        # The repeated key must cross multiple small, LF-aligned R2 pages.
        self.text = NativeText(COORDINATES, (
            ('s.1', ' '.join(['אָ'] * 14 + ['בּ'] + ['אָ'] * 7)),
            ('s.2', 'Café e\u0301 end'),
        ))
        revision = self.source.revision.id
        units = [name for name, _ in self.text.units]
        evidence_basis = OutputBasis(
            'evidence', (revision,), 'synthetic:native-text/1',
            {'d1_body_max_bytes': 16}, {'coordinate_version': COORDINATES, 'unit_ids': units},
        )
        spans = [
            SpanSpec('verse-1', 'verse', '1:1', (('s.1', 0, len(self.text.unit('s.1'))),),
                     'transcribed', {'method': 'synthetic'}),
            SpanSpec('verse-2', 'verse', '1:2', (('s.2', 0, len(self.text.unit('s.2'))),),
                     'transcribed', {'method': 'synthetic'}),
        ]
        spans += literary_spans(self.text, (
            LiteraryUnit(
                'unit', 'Discontinuous opening', (('s.1', 0, 2), ('s.2', 0, 4)),
                'Synthetic analyst', 'synthetic boundaries', 'disputed',
                ({'attribution': 'Alternative analyst',
                  'segments': (('s.1', 0, 2),)},),
            ),
        ))
        self.evidence = build_evidence(
            self.source, self.text, spans, evidence_basis, d1_body_max_bytes=16,
        )
        self.source_parts = build_source_postings(
            self.text, self.evidence,
            configured_basis(self.evidence, self.text, revision=revision),
            RULES, max_units=1, max_scalars=128, max_occurrences=40,
        )
        self.assertEqual(len(self.source_parts), 2)
        self.observations = []
        for row in self.source_parts[0].postings:
            if row['search_key'] != 'א':
                continue
            occurrence = row['occurrence_id']
            self.observations.append(WordObservation(
                occurrence, 'synthetic:alef-form', 'אָ', (
                    AnalysisAlternative('A:' + occurrence, A, 'synthetic:lemma-a',
                                        {'part_of_speech': 'noun'}, 'Provider A', 'Receipt A'),
                    AnalysisAlternative('B:' + occurrence, B, 'synthetic:lemma-b',
                                        {'part_of_speech': 'noun'}, 'Provider B', 'Receipt B'),
                ),
            ))
        self.assertGreater(len(self.observations), 10)
        self.expected = {A: frozenset(item.occurrence_id for item in self.observations),
                         B: frozenset(item.occurrence_id for item in self.observations)}
        self.word_basis = OutputBasis(
            'word_index', (revision, A, B), 'synthetic:word/1',
            {'tokenizer_version': RULES.tokenizer_version,
             'normalization_rule': RULES.normalization_rule,
             'grammar_key_version': 'synthetic:part-of-speech/1'},
            {'coordinate_version': COORDINATES, 'unit_ids': units},
            tuple(self.evidence.output_ids()),
        )
        [self.word] = self._build_words(self.observations)
        self.parts = (*self.source_parts, self.word)
        self.files = tuple(build_index_files(part, encoded_page_cap_bytes=PAGE_CAP)
                           for part in self.parts)
        records = RecordSet().merge(self.evidence)
        for built in self.files:
            records.merge(built.records)
        self.blobs = records.blobs
        self.db = database()
        self.addCleanup(self.db.close)
        self.selection_before = [tuple(row) for row in self.db.execute('SELECT * FROM release_selection')]
        save(records, self.db)  # in-memory D1 shape; no actual D1 writes
        self.outputs = decoded(self.db.execute('SELECT * FROM prepared_outputs').fetchall())
        self.artifacts = decoded(self.db.execute('SELECT * FROM artifacts').fetchall())
        self.coverage = decoded(self.db.execute('SELECT * FROM coverage').fetchall())

    def _build_words(self, observations):
        return build_word_postings(
            self.text, self.source_parts, observations, self.expected, (A, B),
            self.word_basis, normalize=RULES.normalize,
            grammar_keys=lambda alt: ('grammar:' + alt.grammar['part_of_speech'],),
            max_postings=100,
        )

    def test_complete_paged_search_round_trips_and_literary_context(self):
        for part, built in zip(self.parts, self.files):
            saved = next(row for row in self.outputs if row['id'] == part.basis.output_id)
            self.assertEqual(verify_saved_index(
                part.basis, saved, self.artifacts, self.coverage, self.blobs,
                max_page_bytes=PAGE_CAP,
            ), built.manifest)
            self.assertTrue(all(page['byte_length'] <= PAGE_CAP
                for directory in built.manifest['files'] for page in directory['pages']))
        source_manifest = self.files[0].manifest
        word_manifest = self.files[-1].manifest
        source_pages, source_rows = _lookup(source_manifest, self.blobs, 'א')
        lemma_pages, lemma_rows = _lookup(word_manifest, self.blobs, 'lemma:synthetic:lemma-a')
        self.assertGreater(len(source_pages), 2)
        self.assertGreater(len(lemma_pages), 2)
        self.assertEqual(len(source_rows), len(self.observations))
        self.assertEqual(len(lemma_rows), len(self.observations))
        self.assertEqual(len({row['occurrence_id'] for row in lemma_rows}), len(lemma_rows))
        self.assertEqual({row['occurrence_id'] for row in source_rows},
                         {row['occurrence_id'] for row in lemma_rows})
        exact_source = {'source_revision_id': self.source.revision.id,
                        'coordinate_version': COORDINATES, 'units': dict(self.text.units)}
        for row in source_rows:
            self.assertEqual(extract_scalar_segments(row['native_reference'], exact_source), ['אָ'])
            self.assertEqual(row['search_key'], RULES.normalize('אָ'))
        for row in lemma_rows:
            self.assertEqual(row['form'], 'אָ')
            self.assertEqual(extract_scalar_segments(row['native_reference'], exact_source), ['אָ'])
            self.assertEqual({alt['provider'] for alt in row['analyses']}, {'Provider A', 'Provider B'})
            self.assertEqual({alt['analysis_revision_id'] for alt in row['analyses']}, {A, B})
        [literary] = [row for row in self.evidence.rows('native_span') if row['kind'] == 'literary_unit']
        self.assertEqual(len(literary['segments_json']), 2)
        self.assertEqual(literary['basis_json']['boundary_status'], 'disputed')
        self.assertEqual(literary['basis_json']['alternatives'][0]['attribution'],
                         'Alternative analyst')
        self.assertEqual(self.db.execute(
            'SELECT COUNT(*) FROM span_segments WHERE span_id=?', (literary['id'],)
        ).fetchone()[0], 2)
        self.assertEqual([tuple(row) for row in self.db.execute('SELECT * FROM release_selection')],
                         self.selection_before)

    def test_missing_analysis_rejects_word_reuse_without_hiding_source(self):
        [partial_word] = self._build_words(self.observations[:-1])
        self.assertEqual(partial_word.coverage_state, 'partial')
        self.assertIn('missing', partial_word.limitation)
        self.assertNotEqual(partial_word.basis.output_id, self.word.basis.output_id)
        partial_file = build_index_files(partial_word, encoded_page_cap_bytes=PAGE_CAP)
        [partial_saved] = partial_file.records.rows('prepared_output')
        with self.assertRaisesRegex(RecordError, 'Incomplete saved index coverage'):
            verify_saved_index(partial_word.basis, partial_saved,
                               partial_file.records.rows('artifact'),
                               partial_file.records.rows('coverage'), partial_file.records.blobs)
        available = reusable_index_ids(
            (self.source_parts[0].basis, self.source_parts[1].basis, partial_word.basis),
            self.outputs, self.artifacts, self.coverage, self.blobs,
            valid_external_dependencies=self.evidence.output_ids(),
        )
        self.assertEqual(set(available), {part.basis.output_id for part in self.source_parts})

    def test_correction_removal_and_corruption_preserve_unrelated_source(self):
        a, b, word = (part.basis for part in self.parts)
        all_ids = {part.basis.output_id for part in self.parts}
        self.assertEqual(set(reusable_index_ids(
            (word, b, a), self.outputs, self.artifacts, self.coverage, self.blobs,
            valid_external_dependencies=self.evidence.output_ids(),
        )), all_ids)
        corrupted = dict(self.blobs)
        corrupted[self.files[0].postings_artifact_id] = b'corrupted'
        self.assertEqual(reusable_index_ids(
            (a, b, word), self.outputs, self.artifacts, self.coverage, corrupted,
            valid_external_dependencies=self.evidence.output_ids(),
        ), (b.output_id,))
        corrected = replace(a, parameters={**a.parameters, 'recipe_revision': 'synthetic:recipe/2'})
        self.assertEqual(reusable_index_ids(
            (corrected, b, word), self.outputs, self.artifacts, self.coverage, self.blobs,
            valid_external_dependencies=self.evidence.output_ids(),
        ), (b.output_id,))
        self.assertEqual(reusable_index_ids(
            (b, word), self.outputs, self.artifacts, self.coverage, self.blobs,
            valid_external_dependencies=self.evidence.output_ids(),
        ), (b.output_id,))
        self.assertEqual(reusable_index_ids(
            (a, b, word), self.outputs, self.artifacts, self.coverage, self.blobs,
            valid_external_dependencies=(),
        ), ())


if __name__ == '__main__':
    unittest.main()

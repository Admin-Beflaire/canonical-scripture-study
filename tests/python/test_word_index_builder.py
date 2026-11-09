"""Stage 2 synthetic word postings: identity, alternatives and honest coverage."""
from dataclasses import replace
import unittest

from css_shared import extract_scalar_segments
from css_preparation.indexes.source import build_source_postings
from css_preparation.indexes.word import (AnalysisAlternative, WordObservation, build_word_postings)
from css_preparation.prepare.evidence import OutputBasis
from css_preparation.prepare.records import RecordError
from css_preparation.validation import SchemaSubset
from preparation_fixture import COORDINATES, evidence_a, identity, text_a
from test_source_index_builder import RULES, configured_basis

_SCHEMA = SchemaSubset('indexes/posting.v1.schema.json')
A, B = 'synthetic:analysis-a', 'synthetic:analysis-b'


def alternatives(occurrence):
    return (
        AnalysisAlternative(f'a:{occurrence}', A, 'a:lemma-alpha',
                            {'part_of_speech': 'noun'}, 'provider-A', 'admitted receipt A'),
        AnalysisAlternative(f'b:{occurrence}', B, 'b:lemma-beta',
                            {'part_of_speech': 'noun'}, 'provider-B', 'admitted receipt B'),
    )


class WordIndexStageTwo(unittest.TestCase):
    def setUp(self):
        self.text = text_a()
        self.evidence = evidence_a()
        self.source_basis = configured_basis(self.evidence, self.text)
        self.parts = build_source_postings(self.text, self.evidence, self.source_basis, RULES,
                                           max_units=2, max_scalars=64, max_occurrences=20)
        self.first = '1.1:0:2'
        self.second = '1.2:4:6'  # decomposed é: raw scalar offsets (e + combining mark)
        self.observations = (
            WordObservation(self.first, 'form:אב', 'אב', alternatives(self.first)),
            WordObservation(self.second, 'form:e-acute', 'e\u0301', alternatives(self.second)),
        )
        self.expected = {A: frozenset((self.first, self.second)),
                         B: frozenset((self.first, self.second))}
        self.basis = OutputBasis('word_index', (identity('a').revision.id, A, B), 'synthetic:word/1',
                                 {'tokenizer_version': RULES.tokenizer_version,
                                  'normalization_rule': RULES.normalization_rule,
                                  'grammar_key_version': 'synthetic:part-of-speech/1'},
                                 {'coordinate_version': COORDINATES,
                                  'unit_ids': [u for u, _ in self.text.units]},
                                 tuple(self.evidence.output_ids()))

    def build(self, observations=None, expected=None, basis=None, parts=None, **kwargs):
        return build_word_postings(self.text, self.parts if parts is None else parts,
                                   self.observations if observations is None else observations,
                                   self.expected if expected is None else expected,
                                   (A, B), self.basis if basis is None else basis,
                                   normalize=RULES.normalize,
                                   grammar_keys=kwargs.pop('grammar_keys',
                                       lambda a: ('grammar:' + a.grammar['part_of_speech'],)),
                                   max_postings=kwargs.pop('max_postings', 20), **kwargs)

    def test_sorted_contract_and_native_form_round_trip(self):
        result = self.build()
        self.assertEqual(result, self.build(observations=tuple(reversed(self.observations))))
        self.assertEqual(len(result), 1)
        [part] = result
        self.assertEqual(part.coverage_state, 'available')
        self.assertEqual(part.basis.dependencies[-1], self.parts[0].basis.output_id)
        self.assertEqual(part.basis.input_revisions, (identity('a').revision.id, A, B))
        self.assertEqual(part.basis.extent['analysis_occurrence_ids'][A], sorted((self.first, self.second)))
        self.assertIn('form:אב', {row['search_key'] for row in part.postings})
        self.assertIn('form:e', {row['search_key'] for row in part.postings})
        self.assertIn('lemma:a:lemma-alpha', {row['search_key'] for row in part.postings})
        self.assertIn('lemma:b:lemma-beta', {row['search_key'] for row in part.postings})
        self.assertIn('grammar:noun', {row['search_key'] for row in part.postings})
        keys = [(r['search_key'].encode(), r['native_order'], r['occurrence_id'].encode()) for r in part.postings]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(keys), len(set((r['search_key'], r['occurrence_id']) for r in part.postings)))
        for row in part.postings:
            self.assertEqual(_SCHEMA.document_errors(row), [])
            self.assertEqual(row['posting_kind'], 'word')
            self.assertEqual({a['provider'] for a in row['analyses']}, {'provider-A', 'provider-B'})
            self.assertEqual({a['analysis_revision_id'] for a in row['analyses']}, {A, B})
            exact = extract_scalar_segments(row['native_reference'],
                                            {'source_revision_id': identity('a').revision.id,
                                             'coordinate_version': COORDINATES,
                                             'units': dict(self.text.units)})
            self.assertEqual(exact, [row['form']])
        self.assertEqual(next(row for row in part.postings if row['search_key'] == 'form:e')['form'], 'e\u0301')

    def test_missing_declared_analyses_cannot_claim_available_coverage(self):
        [part] = self.build(observations=self.observations[:1])
        self.assertEqual(part.coverage_state, 'partial')
        self.assertIn('2 declared analysis result(s) missing', part.limitation)
        [part] = self.build(observations=(replace(self.observations[0],
                               alternatives=self.observations[0].alternatives[:1]),))
        self.assertEqual(part.coverage_state, 'partial')
        self.assertIn('3 declared analysis result(s) missing', part.limitation)

    def test_reject_foreign_unknown_and_unauthenticated_analyses(self):
        with self.assertRaisesRegex(RecordError, 'native wording'):
            self.build(observations=(replace(self.observations[0],form='changed'),))
        with self.assertRaisesRegex(RecordError, 'unadmitted'):
            self.build(observations=(replace(self.observations[0],
                       alternatives=(replace(alternatives(self.first)[0],analysis_revision_id='unadmitted'),)),))
        with self.assertRaisesRegex(RecordError, 'unknown native occurrences'):
            self.build(expected={A: frozenset(('unknown',)),B: frozenset((self.first,))})
        with self.assertRaisesRegex(RecordError, 'duplicate word occurrence'):
            self.build(observations=(self.observations[0], self.observations[0]))
        with self.assertRaisesRegex(RecordError, 'duplicate analysis identity'):
            self.build(observations=(replace(self.observations[0],
                       alternatives=(alternatives(self.first)[0], alternatives(self.first)[0])),))

    def test_later_received_analysis_changes_immutable_output_identity(self):
        [complete] = self.build()
        [partial] = self.build(observations=self.observations[:1])
        self.assertNotEqual(complete.basis.output_id, partial.basis.output_id)
        revised = replace(self.observations[0], alternatives=(
            replace(self.observations[0].alternatives[0], basis='corrected receipt'),
            self.observations[0].alternatives[1]))
        [changed] = self.build(observations=(revised, self.observations[1]))
        self.assertNotEqual(complete.basis.output_id, changed.basis.output_id)
        self.assertEqual(complete.basis.output_id,
                         self.build(observations=tuple(reversed(self.observations)))[0].basis.output_id)

    def test_dependency_basis_and_caps(self):
        [part] = self.build()
        self.assertNotEqual(part.basis.output_id, self.build(max_postings=9)[0].basis.output_id)
        changed = replace(self.basis, method_version='synthetic:word/2')
        self.assertNotEqual(part.basis.output_id, self.build(basis=changed)[0].basis.output_id)
        with self.assertRaisesRegex(RecordError, 'posting limit'):
            self.build(max_postings=1)
        with self.assertRaisesRegex(RecordError, 'source-search dependency'):
            altered = replace(self.parts[0], basis=replace(self.parts[0].basis,
                      parameters={**self.parts[0].basis.parameters, 'normalization_rule': 'wrong'}))
            self.build(parts=(altered,*self.parts[1:]))
        with self.assertRaisesRegex(RecordError, 'grammar lookup key'):
            self.build(grammar_keys=lambda _: ['unexpected:grammar'])


if __name__ == '__main__':
    unittest.main()

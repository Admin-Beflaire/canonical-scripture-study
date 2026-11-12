"""DP-03 Stage 1: bounded source index, synthetic inputs only."""
from dataclasses import replace
import re
import unicodedata
import unittest

from css_shared import extract_scalar_segments
from css_preparation.indexes.source import TextRules, build_source_postings
from css_preparation.prepare.evidence import NativeText, OutputBasis
from css_preparation.prepare.records import RecordError
from css_preparation.validation import SchemaSubset
from preparation_fixture import COORDINATES, evidence_a, identity, text_a


def whitespace_tokens(body):
    return ((m.start(), m.end()) for m in re.finditer(r'\S+', body))


def stripped_key(text):
    return ''.join(char for char in unicodedata.normalize('NFD', text).casefold()
                   if unicodedata.category(char) != 'Mn')


RULES = TextRules('synthetic:whitespace/1', 'synthetic:strip-marks/1', whitespace_tokens, stripped_key)
_SCHEMA = SchemaSubset('indexes/posting.v1.schema.json')


def configured_basis(evidence, text, *, revision=None, method='synthetic:index/1', dependencies=None):
    revision = revision or identity('a').revision.id
    return OutputBasis('source_search', (revision,), method,
                       {'tokenizer_version': RULES.tokenizer_version, 'normalization_rule': RULES.normalization_rule,
                        'recipe_revision': 'synthetic:recipe/1'},
                       {'coordinate_version': text.coordinate_version,
                        'unit_ids': [unit_id for unit_id, _ in text.units]},
                       tuple(dependencies) if dependencies is not None else tuple(evidence.output_ids()))


class SourceIndexStageOne(unittest.TestCase):
    def setUp(self):
        self.text = text_a()
        self.evidence = evidence_a()
        self.basis = configured_basis(self.evidence, self.text)

    def build(self, *, max_units=2, max_scalars=64, max_occurrences=20,
              encoded_page_cap_bytes=2048, **changes):
        return build_source_postings(changes.get('text', self.text), changes.get('evidence', self.evidence),
                                     changes.get('basis', self.basis), changes.get('rules', RULES),
                                     max_units=max_units, max_scalars=max_scalars,
                                     max_occurrences=max_occurrences,
                                     encoded_page_cap_bytes=encoded_page_cap_bytes)

    def test_partition_order_determinism_and_schema(self):
        first = self.build()
        second = self.build()
        self.assertEqual(first, second)
        self.assertEqual([p.basis.extent['unit_ids'] for p in first], [['1.1', '1.2'], ['1.3', '2.1']])
        self.assertEqual(len({p.basis.output_id for p in first}), 2)
        self.assertTrue(all(p.coverage_state == 'available' for p in first))
        for part in first:
            self.assertEqual(part.basis.dependencies, tuple(self.evidence.output_ids()))
            self.assertEqual(part.basis.parameters['tokenizer_version'], RULES.tokenizer_version)
            keys = [(r['search_key'].encode(), r['native_order'], r['occurrence_id'].encode()) for r in part.postings]
            self.assertEqual(keys, sorted(keys))
            for row in part.postings:
                self.assertEqual(_SCHEMA.document_errors(row), [])
                self.assertIn(row['span_id'], {s['id'] for s in self.evidence.rows('native_span')})
                exact = extract_scalar_segments(row['native_reference'],
                                                {'source_revision_id': row['source_revision_id'],
                                                 'coordinate_version': COORDINATES,
                                                 'units': dict(self.text.units)})
                self.assertEqual(len(exact), 1)
                self.assertEqual(row['search_key'], stripped_key(exact[0]))
        # Native wording is never replaced by the normalized lookup key.
        self.assertTrue(any(row['search_key'] != extract_scalar_segments(
            row['native_reference'], {'source_revision_id': row['source_revision_id'],
                                      'coordinate_version': COORDINATES, 'units': dict(self.text.units)})[0]
            for part in first for row in part.postings))

    def test_full_basis_and_partition_limits_change_id(self):
        first = self.build()
        self.assertNotEqual(first[0].basis.output_id, self.build(max_units=1)[0].basis.output_id)
        self.assertNotEqual(first[0].basis.output_id,
                            self.build(encoded_page_cap_bytes=700)[0].basis.output_id)
        self.assertNotEqual(first[0].basis.output_id, self.build(basis=replace(self.basis,method_version='v2'))[0].basis.output_id)
        self.assertNotEqual(first[0].basis.output_id,
                            self.build(basis=replace(self.basis,dependencies=self.basis.dependencies + ('extra',)))[0].basis.output_id)
        self.assertNotEqual(first[0].basis.output_id,
                            self.build(basis=replace(self.basis,parameters={**self.basis.parameters, 'recipe_revision': 'v2'}))[0].basis.output_id)
        with self.assertRaisesRegex(RecordError, 'limit'):
            self.build(max_units=1, max_scalars=4)
        with self.assertRaisesRegex(RecordError, 'occurrence limit'):
            self.build(max_occurrences=1)

    def test_reject_unverifiable_or_invalid_source(self):
        bad_basis = replace(self.basis,extent={**self.basis.extent, 'unit_ids': ['1.1']})
        with self.assertRaisesRegex(RecordError, 'extent'):
            self.build(basis=bad_basis)
        with self.assertRaisesRegex(RecordError, 'retrievable source evidence'):
            self.build(basis=replace(self.basis,input_revisions=('wrong',)))
        with self.assertRaisesRegex(RecordError, 'evidence output'):
            self.build(basis=replace(self.basis,dependencies=()))
        with self.assertRaisesRegex(RecordError, 'Rule identities'):
            self.build(rules=replace(RULES,normalization_rule='different'))
        with self.assertRaisesRegex(RecordError, 'overlapping'):
            self.build(rules=replace(RULES,tokenize=lambda _: [(0,2),(1,2)]))
        with self.assertRaisesRegex(RecordError, 'Normalizer'):
            self.build(rules=replace(RULES,normalize=lambda _: '\ud800'))
        with self.assertRaisesRegex(RecordError, 'invalid scalar offsets'):
            self.build(rules=replace(RULES,tokenize=lambda _: [(0,1_000_000)]))

    def test_reject_indexed_segment_outside_native_text(self):
        class CorruptEvidence:
            def output_ids(inner):
                return self.evidence.output_ids()

            def rows(inner, kind):
                rows = self.evidence.rows(kind)
                if kind == 'native_span':
                    rows[0]['segments_json'][0]['end'] = 10_000
                return rows

        with self.assertRaisesRegex(RecordError, 'outside its native unit'):
            self.build(evidence=CorruptEvidence())

    def test_order_ranges_of_adjacent_partitions_are_disjoint_around_an_empty_unit(self):
        from css_preparation.prepare.evidence import SpanSpec, build_evidence
        from preparation_fixture import basis
        text = NativeText(COORDINATES, (('1.1', 'aa bb'), ('1.2', ''), ('1.3', 'cc dd'), ('2.1', 'ee')))
        spans = [SpanSpec('v1.1', 'verse', '1:1', (('1.1', 0, 5),), 'transcribed', {'method': 'synthetic'}),
                 SpanSpec('gap-1.2', 'witness_gap', '1:2', (('1.2', 0, 0),), 'gap', {'gap': 'synthetic empty unit'}),
                 SpanSpec('v1.3', 'verse', '1:3', (('1.3', 0, 5),), 'transcribed', {'method': 'synthetic'}),
                 SpanSpec('v2.1', 'verse', '2:1', (('2.1', 0, 2),), 'transcribed', {'method': 'synthetic'})]
        evidence = build_evidence(identity('a'), text, spans, basis(identity('a')), d1_body_max_bytes=24)
        first, second = self.build(text=text, evidence=evidence, basis=configured_basis(evidence, text))
        self.assertEqual([first.basis.extent['unit_ids'], second.basis.extent['unit_ids']], [['1.1', '1.2'], ['1.3', '2.1']])
        bases = text.scalar_bases()
        self.assertEqual(first.order_range, (bases['1.1'], bases['1.1'] + 4))
        self.assertEqual(second.order_range[0], bases['1.3'])
        self.assertLess(first.order_range[1], second.order_range[0], 'the empty unit does not claim the next unit')
        for part in (first, second):
            self.assertTrue(all(part.order_range[0] <= row['native_order'] <= part.order_range[1] for row in part.postings))

    def test_partial_state_is_not_lost(self):
        partial = NativeText(COORDINATES,self.text.units, complete=False,limitation='Synthetic source incomplete')
        from css_preparation.prepare.evidence import build_evidence
        from preparation_fixture import basis as evidence_basis, spans_a
        source = identity('a')
        prepared = build_evidence(source,partial,spans_a(),evidence_basis(source),d1_body_max_bytes=24)
        parts = self.build(text=partial,evidence=prepared,
                           basis=configured_basis(prepared,partial))
        self.assertTrue(all(p.coverage_state == 'partial' and p.limitation == 'Synthetic source incomplete'
                            for p in parts))


if __name__ == '__main__':
    unittest.main()

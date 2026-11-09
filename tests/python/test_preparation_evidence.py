"""Native evidence records: identities, exact wording, R2 ranges, reuse basis (synthetic only)."""
from dataclasses import replace
import hashlib
import sqlite3
import unicodedata
import unittest

from css_shared import extract_scalar_segments
from css_preparation.prepare.evidence import (NativeText, SpanSpec, build_evidence, reusable, span_wording)
from css_preparation.prepare.packages import holdings
from css_preparation.prepare.records import RecordError, RecordSet, decoded

from preparation_fixture import COORDINATES, DECOMPOSED, basis, database, evidence_a, identity, save, spans_a, text_a


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.records = evidence_a()
        self.db = database()
        self.addCleanup(self.db.close)
        save(self.records, self.db)

    def saved(self, table):
        return decoded(self.db.execute(f'SELECT * FROM {table}').fetchall())

    def test_source_hierarchy_keeps_distinct_identities_and_versification(self):
        nodes = {row['kind']: row for row in self.saved('source_nodes')}
        self.assertEqual(list(nodes), ['work', 'edition', 'representation', 'source_revision'])
        self.assertEqual(nodes['source_revision']['parent_id'], nodes['representation']['id'])
        self.assertEqual(nodes['source_revision']['details_json'],
                         {'synthetic': True, 'versification_scheme': 'synthetic:scheme-a/1'})
        self.assertEqual({row['attribution'] for row in nodes.values()}, {'Synthetic Provider a'})

    def test_saved_wording_round_trips_to_the_exact_native_text(self):
        payloads = {row['content_id']: row['exact_text'] for row in self.saved('text_payloads')}
        spans = self.saved('native_spans')
        basis_text = {'source_revision_id': identity('a').revision.id, 'coordinate_version': COORDINATES,
                      'units': dict(text_a().units)}
        for span in spans:
            reference = {'schema_version': 'native-reference/1', 'source_revision_id': span['source_revision_id'],
                         'coordinate_version': span['coordinate_version'], 'segments': span['segments_json']}
            self.assertEqual(span_wording(span, payloads, self.records.blobs),
                             extract_scalar_segments(reference, basis_text), span['id'])
        verse = next(span for span in spans if span['label'] == '1:2')
        self.assertIn(DECOMPOSED, payloads[verse['content_id']])
        self.assertNotEqual(payloads[verse['content_id']], unicodedata.normalize('NFC', payloads[verse['content_id']]))

    def test_short_single_segments_use_d1_and_long_or_discontinuous_bodies_use_r2_ranges(self):
        spans = {span['label']: span for span in self.saved('native_spans')}
        self.assertIsNotNone(spans['1:1']['content_id'])
        self.assertEqual(spans['1:1']['body_ranges_json'], [])
        for label in ('1:3', 'Chapter 1'):
            self.assertIsNone(spans[label]['content_id'])
            self.assertTrue(spans[label]['body_ranges_json'])
        self.assertEqual(len(spans['Chapter 1']['body_ranges_json']), 3)
        self.assertEqual((spans['2:2']['reading_kind'], spans['2:2']['content_id'], spans['2:2']['body_ranges_json']),
                         ('gap', None, []))
        [artifact] = self.saved('artifacts')
        body = self.records.blobs[artifact['id']]
        self.assertEqual((artifact['sha256'], artifact['byte_count']), (hashlib.sha256(body).hexdigest(), len(body)))
        self.assertEqual(artifact['registered_locator'], f"prepared/{artifact['sha256']}/native-body.txt")
        self.assertEqual(body.decode(), ''.join(unit for _, unit in text_a().units))
        self.assertEqual(spans['1:1']['parent_id'], spans['Chapter 1']['id'])
        self.assertEqual([span['native_order'] for span in spans.values()], list(range(len(spans))))

    def test_tampered_range_or_payload_is_rejected(self):
        span = next(row for row in self.saved('native_spans') if row['label'] == '1:3')
        blobs = {key: value.replace(b'four', b'FOUR') for key, value in self.records.blobs.items()}
        with self.assertRaisesRegex(RecordError, 'digest'):
            span_wording(span, {}, blobs)
        verse = next(row for row in self.saved('native_spans') if row['label'] == '1:1')
        with self.assertRaisesRegex(RecordError, 'digest'):
            span_wording(verse, {verse['content_id']: 'altered'}, {})

    def test_annotation_and_coverage_keep_attribution_and_extent(self):
        [note] = self.saved('annotations')
        self.assertEqual((note['provider'], note['details_json']), ('Synthetic annotator', {'note': 'decomposed accent kept'}))
        [coverage] = self.saved('coverage')
        self.assertEqual((coverage['capability'], coverage['state'], coverage['limitation']), ('source_context', 'available', None))
        partial = NativeText(COORDINATES, text_a().units, complete=False, limitation='Synthetic: chapter 3 not supplied')
        [row] = evidence_a(text=partial).rows('coverage')
        self.assertEqual((row['state'], row['limitation']), ('partial', 'Synthetic: chapter 3 not supplied'))

    def test_reuse_needs_the_complete_basis_not_equal_text(self):
        source = identity('a')
        [saved] = self.saved('prepared_outputs')
        self.assertTrue(reusable(saved, basis(source)))
        for changed in (basis(source, parameters={'d1_body_max_bytes': 25}), basis(source, dependencies=('other',)),
                        replace(basis(source), method_version='synthetic:native-text/2'),
                        replace(basis(source), extent={'unit_ids': ['1.1']})):
            self.assertFalse(reusable(saved, changed))
            self.assertNotEqual(changed.output_id, saved['id'])

    def test_coordinate_version_is_part_of_the_output_identity(self):
        source = identity('a')
        other = replace(basis(source), extent={**basis(source).extent, 'coordinate_version': 'synthetic:bytes/1'})
        self.assertNotEqual(other.output_id, basis(source).output_id)
        self.assertFalse(reusable(self.saved('prepared_outputs')[0], other))
        with self.assertRaisesRegex(RecordError, 'coordinate version'):
            build_evidence(source, text_a(), spans_a(), other, d1_body_max_bytes=24)
        with self.assertRaisesRegex(RecordError, 'coordinate version'):
            build_evidence(source, text_a(), spans_a(), replace(basis(source), extent={'unit_ids': ['1.1']}),
                           d1_body_max_bytes=24)

    def test_coverage_claims_only_units_whose_wording_a_span_exposes(self):
        source = identity('a')
        cases = {
            'unspanned': [replace(s, parent_key=None) for s in spans_a() if s.key not in ('chapter-1', 'v1.3')],
            'half': [replace(s, parent_key=None) for s in spans_a() if s.key not in ('chapter-1', 'v1.3')]
                    + [SpanSpec('half', 'verse', '1:3a', (('1.3', 0, 10),), 'transcribed', {})],
            'gap-only': [SpanSpec('gap', 'gap', 'gap', (('1.1', 0, 0),), 'gap', {})],
        }
        expected = {'unspanned': ('partial', ['1.1', '1.2', '2.1']), 'half': ('partial', ['1.1', '1.2', '2.1']),
                    'gap-only': ('missing', [])}
        for name, spans in cases.items():
            [row] = build_evidence(source, text_a(), spans, basis(source), d1_body_max_bytes=24).rows('coverage')
            self.assertEqual((row['state'], row['native_extent_json']['unit_ids']), expected[name], name)
            self.assertIn('1.3', row['limitation'], name)
        records = build_evidence(source, text_a(), cases['unspanned'], basis(source), d1_body_max_bytes=24)
        held = holdings(records.rows('source_node'), records.rows('coverage'))
        self.assertEqual(held[source.revision.id].unit_ids, {'1.1', '1.2', '2.1'})
        partial = NativeText(COORDINATES, text_a().units, complete=False, limitation='Synthetic: chapter 3 not supplied')
        [row] = build_evidence(source, partial, cases['unspanned'], basis(source), d1_body_max_bytes=24).rows('coverage')
        self.assertTrue(row['limitation'].startswith('Synthetic: chapter 3 not supplied; 1 supplied unit'))

    def test_shared_identities_are_saved_once_and_conflicts_fail(self):
        source = identity('a')
        again = build_evidence(source, text_a(), spans_a(), basis(source, parameters={'d1_body_max_bytes': 0}),
                               d1_body_max_bytes=0)
        save(again, self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM source_nodes').fetchone()[0], 4)
        self.assertEqual(self.db.execute('SELECT count(*) FROM prepared_outputs').fetchone()[0], 2)
        renamed = RecordSet()
        renamed.add('source_node', {**self.saved('source_nodes')[0], 'name': 'Renamed'})
        with self.assertRaises(sqlite3.IntegrityError):
            save(renamed, self.db)

    def test_invalid_native_input_is_refused(self):
        source = identity('a')
        bad_spans = [
            [SpanSpec('x', 'verse', 'x', (('1.1', 0, 99),), 'transcribed', {})],
            [SpanSpec('x', 'verse', 'x', (('1.3', 0, 5), ('1.3', 4, 9)), 'transcribed', {})],
            [SpanSpec('x', 'verse', 'x', (('9.9', 0, 1),), 'transcribed', {})],
            [SpanSpec('x', 'gap', 'x', (('1.1', 0, 1),), 'gap', {})],
            [SpanSpec('x', 'verse', 'x', (('1.1', 0, 0),), 'transcribed', {})],
            [SpanSpec('x', 'verse', 'x', (('1.1', 0, 1),), 'normalized', {})],
            [SpanSpec('x', 'verse', 'x', (), 'transcribed', {})],
            [SpanSpec('x', 'verse', 'x', (('1.1', 0, 1),), 'transcribed', {})] * 2,
            [SpanSpec('x', 'verse', 'x', (('1.1', 0, 1),), 'transcribed', {}, parent_key='y'),
             SpanSpec('y', 'verse', 'y', (('1.1', 1, 2),), 'transcribed', {}, parent_key='x')],
        ]
        for spans in bad_spans:
            with self.assertRaises(RecordError, msg=spans):
                build_evidence(source, text_a(), spans, basis(source), d1_body_max_bytes=24)
        with self.assertRaises(RecordError):
            build_evidence(identity('b'), text_a(), spans_a(), basis(source), d1_body_max_bytes=24)
        for units in ((), (('u', 'a'), ('u', 'b')), (('u', '\ud800'),)):
            with self.assertRaises(RecordError):
                NativeText(COORDINATES, units)
        with self.assertRaises(RecordError):
            NativeText(COORDINATES, (('u', 'a'),), complete=False)

    def test_record_set_refuses_release_records_and_invalid_rows(self):
        records = RecordSet()
        for kind in ('release', 'release_output', 'release_selection'):
            with self.assertRaisesRegex(RecordError, 'does not write'):
                records.add(kind, {})
        with self.assertRaisesRegex(RecordError, 'Invalid'):
            records.add('study_package', {'id': 'p', 'output_id': 'o', 'subject': 's', 'source_refs_json': [],
                                          'dependency_ids_json': ['o']})
        with self.assertRaisesRegex(RecordError, 'Conflicting bytes'):
            records.add_blob('a', b'1')
            records.add_blob('a', b'2')


if __name__ == '__main__':
    unittest.main()

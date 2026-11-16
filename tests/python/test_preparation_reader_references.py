"""Synthetic candidate rows prepared with the real STEPBible parser."""
import json
import sqlite3
import unittest

from css_preparation.adapters.stepbible.reader_references import prepare_reader_reference_unit
from css_preparation.prepare.evidence import span_wording
from css_preparation.prepare.literary import LiteraryUnit
from css_preparation.prepare.records import RecordError, migrations, scoped_query
from stepbible_fixture import component, row


class PrepareReaderReferencesTest(unittest.TestCase):
    def test_mixed_psalm_and_discontinuous_literary_unit_keep_scalar_ranges(self):
        source, data = component(lines=[
            row('Psa.3.0(3.1)#01=L', 'עַ־'),
            row('Psa.3.0(3.1)#02=L', 'גַ'),
            row('Psa.3.1#03=L', 'טָ'),
            row('Psa.3.2#01=L', 'פַ'),
            row('Psa.3.3#01=L', 'קַ'),
        ])
        unit = LiteraryUnit('opening', 'Synthetic opening',
                            (('Psa.3.1', 0, 5), ('Psa.3.3', 0, 2)),
                            'fixture', 'fixture/1')
        records = prepare_reader_reference_unit(
            data, source, 'Psa', ['Psa.3.1', 'Psa.3.2', 'Psa.3.3'], literary_units=[unit])
        [base] = records.rows('reader_reference_base')
        self.assertEqual(base['reader_scheme_version'], 'nrsva/1')
        self.assertEqual(base['checked_extent_json']['ranges'], [
            {'book_id': 'Ps', 'chapter': 3, 'first_verse': 2, 'last_verse': 3},
        ])
        self.assertEqual(records.rows('coverage'), [])
        by_span = {span['id']: span for span in records.rows('native_span')}
        title, numbered = records.rows('reader_reference_link')
        self.assertEqual([title['reader_ref'], numbered['reader_ref']], ['Ps.3.1', 'Ps.3.1'])
        self.assertEqual([title['role'], numbered['role']], ['superscription', 'numbered_text'])
        self.assertEqual(title['basis_json']['source_markers'], ['Psa.3.0'])
        self.assertEqual(span_wording(by_span[title['span_id']], {}, records.blobs), ['עַ־גַ'])
        self.assertEqual(span_wording(by_span[numbered['span_id']], {}, records.blobs), ['טָ'])

        [literary] = [span for span in by_span.values() if span['kind'] == 'literary_unit']
        self.assertEqual(span_wording(literary, {}, records.blobs), ['עַ־גַ', 'קַ'])
        self.assertEqual([seg['unit_id'] for seg in literary['segments_json']], ['Psa.3.1', 'Psa.3.3'])

        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('PRAGMA foreign_keys=ON')
        for migration in migrations():
            db.executescript(migration.read_text(encoding='utf-8'))
        with db:
            for sql, parameters in records.statements():
                db.execute(sql, parameters)
        by_output = records.output_ids()
        self.assertEqual(db.execute(*scoped_query('reader_reference_base', by_output)).fetchone()[3], 'nrsva/1')
        self.assertEqual(len(db.execute(*scoped_query('reader_reference_link', by_output)).fetchall()), 2)
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(db.execute('SELECT count(*) FROM release_outputs').fetchone()[0], 0)
        manifest = db.execute('SELECT parameters_json FROM prepared_outputs').fetchone()[0]
        self.assertEqual(json.loads(manifest)['reader_scheme_version'], 'nrsva/1')

    def test_valid_different_number_is_explicit_and_a_gap_has_no_wording(self):
        source, data = component(lines=[row('Mal.4.6(3.24)#01=L', 'פַ')])
        records = prepare_reader_reference_unit(data, source, 'Mal', ['Mal.3.24'])
        self.assertEqual(records.rows('reader_reference_base'), [])
        [link] = records.rows('reader_reference_link')
        [span] = records.rows('native_span')
        self.assertEqual(link['reader_ref'], 'Mal.4.6')
        self.assertEqual(span['segments_json'][0]['unit_id'], 'Mal.3.24')

        source, data = component('tagnt')
        records = prepare_reader_reference_unit(data, source, 'Mat', ['Mat.1.4'])
        [gap] = records.rows('reader_reference_link')
        self.assertEqual((gap['reader_ref'], gap['status'], gap['span_id']), ('Matt.1.4', 'missing', None))
        self.assertEqual(records.rows('reader_reference_base'), [])

    def test_invalid_marker_and_split_reader_anchor_are_rejected(self):
        source, data = component(lines=[row('Mal.4.7(3.24)#01=L', 'פַ')])
        with self.assertRaisesRegex(RecordError, 'Mal.4.7 is outside the NRSVA catalogue'):
            prepare_reader_reference_unit(data, source, 'Mal', ['Mal.3.24'])

        source, data = component(lines=[
            row('Psa.11.0(11.1)#01=L', 'עַ'),
            row('Psa.11.1(11.2)#01=L', 'טָ'),
        ])
        with self.assertRaisesRegex(RecordError, 'crosses the requested native unit boundary'):
            prepare_reader_reference_unit(data, source, 'Psa', ['Psa.11.1'])
        records = prepare_reader_reference_unit(data, source, 'Psa', ['Psa.11.1', 'Psa.11.2'])
        self.assertEqual([link['role'] for link in records.rows('reader_reference_link')],
                         ['superscription', 'numbered_text'])

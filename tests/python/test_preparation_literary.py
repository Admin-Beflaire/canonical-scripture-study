"""Literary units, span navigation and admitted mappings (synthetic only)."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from css_preparation.prepare.evidence import NativeText, OutputBasis, build_evidence, navigation_rows
from css_preparation.prepare.literary import LiteraryUnit, literary_spans, mapping_relationships, span_index
from css_preparation.prepare.records import RecordError, decoded

from preparation_fixture import (COORDINATES, basis, database, evidence_a, evidence_b, identity, mappings, save,
                                 spans_a, text_a)

ROOT = Path(__file__).resolve().parents[2]
INDEXES = json.loads((ROOT / 'tests/conformance/indexes/fixture.json').read_text(encoding='utf-8'))
OVERLAP = ('SELECT DISTINCT ss.span_id FROM span_segments ss WHERE ss.source_revision_id=? AND ss.kind=? '
           'AND ss.start_order<=? AND ss.end_order>=? ORDER BY ss.span_id')


def units():
    return [
        LiteraryUnit('unit-a', 'Opening unit', (('1.1', 0, 8), ('1.2', 0, 12), ('1.3', 0, 4)), 'Synthetic analyst',
                     'synthetic discourse markers', 'disputed',
                     ({'attribution': 'Synthetic second analyst', 'segments': (('1.1', 0, 8), ('1.2', 0, 12))},)),
        LiteraryUnit('frame', 'Discontinuous frame', (('1.1', 0, 8), ('2.1', 0, 6)), 'Synthetic analyst',
                     'synthetic inclusio'),
    ]


def mapping_basis(dependencies):
    return OutputBasis('versification_mapping', ('synthetic:map:revision-1', 'synthetic:a:revision-1',
                                                 'synthetic:b:revision-1'), 'synthetic:mapping/1', {}, {},
                       tuple(dependencies))


class LiteraryTest(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.a = evidence_a(spans=spans_a() + literary_spans(text_a(), units()))
        self.b = evidence_b()
        save(self.a, self.db)
        save(self.b, self.db)

    def spans(self, label):
        return decoded(self.db.execute('SELECT * FROM native_spans WHERE label=?', (label,)).fetchall())

    def test_literary_units_keep_segments_disputed_boundaries_and_alternatives(self):
        [unit] = self.spans('Opening unit')
        self.assertEqual(unit['kind'], 'literary_unit')
        self.assertEqual(len(unit['segments_json']), 3)
        self.assertEqual(unit['basis_json']['boundary_status'], 'disputed')
        self.assertEqual(unit['basis_json']['alternatives'][0]['attribution'], 'Synthetic second analyst')
        self.assertEqual(len(unit['body_ranges_json']), 3)
        [frame] = self.spans('Discontinuous frame')
        self.assertEqual([s['unit_id'] for s in frame['segments_json']], ['1.1', '2.1'])
        self.assertEqual(frame['basis_json']['boundary_status'], 'agreed')

    def test_navigation_rows_cover_every_segment_and_find_overlapping_units(self):
        spans = self.db.execute('SELECT id, segments_json FROM native_spans').fetchall()
        rows = self.db.execute('SELECT span_id, count(*) FROM span_segments GROUP BY span_id').fetchall()
        self.assertEqual(dict(rows), {row['id']: len(json.loads(row['segments_json'])) for row in spans})
        revision = identity('a').revision.id
        [verse] = [span for span in self.spans('2:1') if span['source_revision_id'] == revision]
        [interval] = self.db.execute('SELECT start_order,end_order FROM span_segments WHERE span_id=?', (verse['id'],))
        found = [row[0] for row in self.db.execute(OVERLAP, (revision, 'literary_unit', interval[1], interval[0]))]
        self.assertEqual(found, [self.spans('Discontinuous frame')[0]['id']])
        [verse] = [span for span in self.spans('1:2') if span['source_revision_id'] == revision]
        [interval] = self.db.execute('SELECT start_order,end_order FROM span_segments WHERE span_id=?', (verse['id'],))
        found = {row[0] for row in self.db.execute(OVERLAP, (revision, 'literary_unit', interval[1], interval[0]))}
        self.assertEqual(found, {self.spans('Opening unit')[0]['id']})

    def test_navigation_matches_the_index_conformance_fixture(self):
        delta = INDEXES['evidence_delta']
        expected = sorted(INDEXES['span_segments'], key=lambda r: (r['span_id'], r['segment_ordinal']))
        rows = []
        for revision in sorted({span['source_revision_id'] for span in delta['native_span']}):
            spans = [span for span in delta['native_span'] if span['source_revision_id'] == revision]
            unit_ids = {segment['unit_id'] for span in spans for segment in span['segments_json']}
            lengths = {unit: max(s['end'] for span in spans for s in span['segments_json'] if s['unit_id'] == unit)
                       for unit in unit_ids}
            text = NativeText(COORDINATES, tuple((unit, 'x' * lengths[unit]) for unit in sorted(unit_ids)))
            rows += navigation_rows(spans, text)
        self.assertEqual(sorted(rows, key=lambda r: (r['span_id'], r['segment_ordinal'])), expected)

    def test_invalid_literary_boundaries_are_refused(self):
        good = units()[1]
        bad = [
            LiteraryUnit('x', 'x', (('2.1', 0, 6), ('1.1', 0, 8)), 'p', 'm'),
            LiteraryUnit('x', 'x', (('1.3', 0, 6), ('1.3', 4, 9)), 'p', 'm'),
            LiteraryUnit('x', 'x', (('1.1', 0, 99),), 'p', 'm'),
            LiteraryUnit('x', 'x', (), 'p', 'm'),
            LiteraryUnit('x', 'x', good.segments, 'p', 'm', 'disputed'),
            LiteraryUnit('x', 'x', good.segments, 'p', 'm', 'agreed', ({'attribution': 'q', 'segments': good.segments},)),
            LiteraryUnit('x', 'x', good.segments, 'p', 'm', 'probable'),
            LiteraryUnit('x', 'x', good.segments, '', 'm'),
            LiteraryUnit('x', 'x', good.segments, 'p', 'm', 'disputed', ({'attribution': '', 'segments': good.segments},)),
            LiteraryUnit('x', 'x', good.segments, 'p', 'm', 'disputed', ({'attribution': 'q', 'segments': (('9', 0, 1),)},)),
        ]
        for unit in bad:
            with self.assertRaises(RecordError, msg=unit):
                literary_spans(text_a(), [unit])

    def mapping(self, items=None, dependencies=None):
        index = span_index(decoded(self.db.execute('SELECT * FROM native_spans').fetchall()))
        outputs = dependencies if dependencies is not None else self.a.output_ids() + self.b.output_ids()
        return mapping_relationships(items if items is not None else mappings(), index, mapping_basis(outputs),
                                     provider='Synthetic mapping table')

    def test_admitted_mappings_keep_partial_disputed_and_missing_correspondence(self):
        records = self.mapping()
        save(records, self.db)
        rows = self.db.execute(
            'SELECT r.status, r.basis_json, m.role, m.correspondence, m.gap_reason, f.label AS from_label, '
            't.label AS to_label FROM relationships r JOIN relation_members m ON m.relationship_id=r.id AND m.role=\'to\' '
            'JOIN relation_members fm ON fm.relationship_id=r.id AND fm.role=\'from\' JOIN native_spans f ON f.id=fm.span_id '
            'LEFT JOIN native_spans t ON t.id=m.span_id ORDER BY r.id').fetchall()
        summary = [(row['from_label'], row['to_label'], row['status'], row['correspondence']) for row in rows]
        self.assertEqual(summary, [
            ('1:1', '1:1', 'supported', 'exact'), ('1:2', '1:2', 'supported', 'partial'),
            ('1:3', '1:3', 'disputed', 'unresolved'), ('2:1', '1:4', 'supported', 'exact'),
            ('2:2', None, 'supported', 'missing')])
        self.assertEqual(rows[-1]['gap_reason'], 'Synthetic: witness b has no counterpart')
        self.assertEqual(json.loads(rows[0]['basis_json'])['provider'], 'Synthetic mapping table')
        # Same number, different verse: b's 2:1 is never linked to a's 2:1 without an admitted mapping.
        [b21] = [s for s in self.spans('2:1') if s['source_revision_id'] == 'synthetic:b:revision-1']
        self.assertEqual(self.db.execute('SELECT count(*) FROM relation_members WHERE span_id=?', (b21['id'],)).fetchone()[0], 0)
        [coverage] = decoded(self.db.execute("SELECT * FROM coverage WHERE capability='versification_mapping'"))
        self.assertEqual(coverage['native_extent_json'], {'unit_ids': ['1.1', '1.2', '1.3', '2.1']})

    def test_composite_and_unresolved_targets(self):
        items = [{'from': mappings()[2]['from'], 'to': [mappings()[1]['to'][0], mappings()[2]['to'][0]],
                  'status': 'exact', 'basis': 'synthetic split verse'},
                 {'from': mappings()[0]['from'], 'to': [], 'status': 'unresolved', 'basis': 'synthetic',
                  'gap_reason': 'Synthetic: tables disagree'}]
        records = self.mapping(items)
        members = records.rows('relation_member')
        self.assertEqual([m['correspondence'] for m in members if m['role'] == 'to'], ['composite', 'composite', 'unresolved'])
        self.assertEqual(records.rows('relationship')[1]['status'], 'unresolved')

    def test_unresolvable_endpoints_invalid_mappings_and_undeclared_dependencies_fail(self):
        moved = deepcopy(mappings()[0])
        moved['to'][0]['segments'][0]['end'] = 7
        with self.assertRaisesRegex(RecordError, 'no prepared span'):
            self.mapping([moved])
        for invalid in ({**mappings()[0], 'status': 'probable'}, {**mappings()[0], 'basis': ' '},
                        {**mappings()[4], 'gap_reason': None}, {**mappings()[0], 'to': []}):
            with self.assertRaises(ValueError):
                self.mapping([invalid])
        with self.assertRaisesRegex(RecordError, 'undeclared'):
            self.mapping(dependencies=self.a.output_ids())
        with self.assertRaisesRegex(RecordError, 'provider'):
            mapping_relationships([], {}, mapping_basis([]), provider='')


if __name__ == '__main__':
    unittest.main()

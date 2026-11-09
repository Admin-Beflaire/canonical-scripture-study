"""Packages, statement incorporation and correction/removal, end to end on a synthetic native fixture."""
from dataclasses import replace
import sqlite3
import unittest

from css_preparation.prepare.evidence import NativeText, OutputBasis, build_evidence, span_wording
from css_preparation.prepare.literary import mapping_relationships, span_index
from css_preparation.prepare.packages import (PackageSpec, StatementError, dependencies_of, holdings,
                                              incorporate_statement, rebuild_plan, refresh_packages)
from css_preparation.prepare.records import RecordError, RecordSet, decoded

from preparation_fixture import (COORDINATES, basis, database, evidence_a, evidence_b, identity, mappings, reference,
                                 save, spans_a, text_a)

STATEMENTS = [
    {'name': 'Synthetic statement fixture', 'version': '1', 'status': 'approved',
     'scripture_basis': [reference('a', '1.1', 0, 8)], 'owner_approval_ref': 'synthetic:test-approval/1'},
    {'name': 'Synthetic statement fixture', 'version': '2', 'status': 'approved',
     'scripture_basis': [reference('a', '1.2', 0, 12)], 'owner_approval_ref': 'synthetic:test-approval/2'},
    {'name': 'Synthetic statement fixture', 'version': '3-draft', 'status': 'draft',
     'scripture_basis': [reference('a', '1.1', 0, 8)], 'owner_approval_ref': None},
]
INSTRUCTION = {'name': 'Synthetic statement fixture', 'version': '2', 'owner_approval_ref': 'synthetic:test-approval/2'}
STATEMENT_BASIS = OutputBasis('character_statement', ('synthetic:statement:revision-2',), 'synthetic:statement/1', {}, {})


def package_specs():
    return [
        PackageSpec('opening', 'Synthetic opening lookup', (reference('a', '1.1', 0, 8), reference('b', '1.1', 0, 8)),
                    ({'attribution': 'Synthetic external commentator', 'locator': 'https://example.invalid/not-held'},)),
        PackageSpec('b-only', 'Synthetic b lookup', (reference('b', '1.4', 0, 6),)),
        PackageSpec('external-only', 'Synthetic external lookup', (),
                    ({'attribution': 'Synthetic external commentator', 'locator': 'https://example.invalid/x'},)),
    ]


class FlowTest(unittest.TestCase):
    """Native evidence -> mappings -> packages -> statement, then correction and removal."""

    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.a, self.b = evidence_a(), evidence_b()
        for records in (self.a, self.b):
            save(records, self.db)
        self.mapping = self.build_mapping(self.a.output_ids() + self.b.output_ids())
        save(self.mapping, self.db)
        self.packages, self.report = self.build_packages()
        save(self.packages, self.db)

    def rows(self, table, where='', params=()):
        return decoded(self.db.execute(f'SELECT * FROM {table} {where}', params).fetchall())

    def build_mapping(self, dependencies, items=None):
        index = span_index(self.rows('native_spans', 'WHERE output_id IN (%s)' % ','.join('?' * len(dependencies)),
                                     dependencies))
        output = OutputBasis('versification_mapping', ('synthetic:map:revision-1',), 'synthetic:mapping/1', {}, {},
                             tuple(dependencies))
        return mapping_relationships(items if items is not None else mappings(), index, output,
                                     provider='Synthetic mapping table')

    def build_packages(self, current=None):
        current = current or self.a.output_ids() + self.b.output_ids()
        held = holdings(self.rows('source_nodes'), self.rows(
            'coverage', 'WHERE output_id IN (%s)' % ','.join('?' * len(current)), current))
        output = OutputBasis('study_package', ('synthetic:package-recipe/1',), 'synthetic:packages/1', {}, {},
                             tuple(current))
        return refresh_packages(package_specs(), held, output)

    def test_packages_hold_attributed_current_pointers_and_no_answers(self):
        packages = {row['id'].rsplit('/', 1)[1]: row for row in self.rows('study_packages')}
        self.assertEqual(sorted(packages), ['b-only', 'opening'])
        opening = packages['opening']
        self.assertEqual([ref['availability'] for ref in opening['source_refs_json']], ['held', 'held', 'external'])
        self.assertEqual([ref['attribution'] for ref in opening['source_refs_json']],
                         ['Synthetic Provider a', 'Synthetic Provider b', 'Synthetic external commentator'])
        self.assertEqual(opening['dependency_ids_json'], sorted(self.a.output_ids() + self.b.output_ids()))
        self.assertEqual(set(opening), {'id', 'output_id', 'subject', 'source_refs_json', 'dependency_ids_json'})
        self.assertEqual(self.report['omitted_packages'], ['external-only'])

    def test_only_the_instructed_approved_statement_is_incorporated(self):
        self.assertIsNone(incorporate_statement(None, STATEMENTS, STATEMENT_BASIS))
        records = incorporate_statement(INSTRUCTION, STATEMENTS, STATEMENT_BASIS)
        save(records, self.db)
        [row] = self.rows('character_statements')
        self.assertEqual((row['name'], row['version'], row['status'], row['owner_approval_ref']),
                         ('Synthetic statement fixture', '2', 'approved', 'synthetic:test-approval/2'))
        self.assertEqual(row['scripture_basis_json'], [reference('a', '1.2', 0, 12)])
        refused = [
            {**INSTRUCTION, 'version': '3-draft', 'owner_approval_ref': 'x'},
            {**INSTRUCTION, 'owner_approval_ref': 'synthetic:test-approval/1'},
            {**INSTRUCTION, 'version': '9'},
            {**INSTRUCTION, 'extra': 'second version'},
            [INSTRUCTION, INSTRUCTION],
        ]
        for instruction in refused:
            with self.assertRaises(StatementError, msg=instruction):
                incorporate_statement(instruction, STATEMENTS, STATEMENT_BASIS)
        with self.assertRaises(StatementError):
            incorporate_statement(INSTRUCTION, STATEMENTS + [STATEMENTS[1]], STATEMENT_BASIS)
        with self.assertRaises(StatementError):
            incorporate_statement(INSTRUCTION, STATEMENTS, replace(STATEMENT_BASIS, kind='evidence'))

    def test_correcting_a_source_rebuilds_its_dependents_and_keeps_unrelated_outputs(self):
        outputs = dependencies_of(self.rows('prepared_outputs'))
        [a_output], [b_output] = self.a.output_ids(), self.b.output_ids()
        [mapping_output], [package_output] = self.mapping.output_ids(), self.packages.output_ids()
        plan = rebuild_plan(outputs, changed=[a_output])
        self.assertEqual(plan.rebuild, {a_output, mapping_output, package_output})
        self.assertEqual((plan.omit, plan.retain), (frozenset(), {b_output}))

        # A corrected revision of source a is a new output; saved rows stay as they were.
        source = identity('a', revision='2')
        corrected = NativeText(COORDINATES, tuple((unit, body.replace('one', 'ONE')) for unit, body in text_a().units))
        new_a = build_evidence(source, corrected, spans_a(), basis(source), d1_body_max_bytes=24)
        save(new_a, self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM native_spans WHERE output_id=?', (a_output,)).fetchone()[0],
                         len(spans_a()))
        current = new_a.output_ids() + [b_output]
        items = [dict(item, **{'from': {**item['from'], 'source_revision_id': source.revision.id}}) for item in mappings()]
        new_mapping = self.build_mapping(current, items)
        save(new_mapping, self.db)
        new_packages, report = self.build_packages(current)
        save(new_packages, self.db)
        self.assertEqual(report['dropped_references'],
                         [['opening', 'synthetic:a:revision-1', 'source extent is not currently held']])
        candidate = set(current) | set(new_mapping.output_ids()) | set(new_packages.output_ids())
        self.assertIn(b_output, candidate)
        self.assertTrue(candidate.isdisjoint({a_output, mapping_output, package_output}))
        [verse] = self.rows('native_spans', "WHERE output_id=? AND label='1:1'", (new_a.output_ids()[0],))
        payloads = {row['content_id']: row['exact_text'] for row in self.rows('text_payloads')}
        self.assertEqual(span_wording(verse, payloads, {}), ['אב 😀 ONE'])

    def test_removing_a_source_omits_it_and_rebuilds_only_its_dependents(self):
        outputs = dependencies_of(self.rows('prepared_outputs'))
        [a_output], [b_output] = self.a.output_ids(), self.b.output_ids()
        plan = rebuild_plan(outputs, removed=[b_output])
        self.assertEqual(plan.omit, {b_output})
        self.assertEqual(plan.rebuild, set(self.mapping.output_ids() + self.packages.output_ids()))
        self.assertEqual(plan.retain, {a_output})
        packages, report = self.build_packages([a_output])
        self.assertEqual(report['omitted_packages'], ['b-only', 'external-only'])
        [opening] = packages.rows('study_package')
        self.assertEqual(opening['dependency_ids_json'], [a_output])
        with self.assertRaisesRegex(RecordError, 'no prepared span'):
            self.build_mapping([a_output])
        with self.assertRaises(RecordError):
            rebuild_plan(outputs, changed=['unknown'])
        with self.assertRaises(RecordError):
            rebuild_plan(outputs, changed=[a_output], removed=[a_output])

    def test_package_dependencies_must_be_declared_and_selected_rows_stay_immutable(self):
        held = holdings(self.rows('source_nodes'), self.rows('coverage'))
        output = OutputBasis('study_package', ('synthetic:package-recipe/1',), 'synthetic:packages/1', {}, {},
                             tuple(self.a.output_ids()))
        with self.assertRaisesRegex(RecordError, 'undeclared'):
            refresh_packages(package_specs(), held, output)
        with self.assertRaisesRegex(RecordError, 'study_package'):
            refresh_packages(package_specs(), held, replace(output, kind='evidence'))
        # Preparation cannot write into a selected release's outputs.
        self.db.execute("INSERT INTO releases VALUES ('r1','m','r','{}','c','q','s')")
        for output_id in self.a.output_ids():
            self.db.execute('INSERT INTO release_outputs VALUES (?,?)', ('r1', output_id))
        self.db.execute("UPDATE release_selection SET current_release_id='r1'")
        span = self.rows('native_spans', 'WHERE output_id=? LIMIT 1', (self.a.output_ids()[0],))[0]
        late = RecordSet()
        late.add('annotation', {'id': 'late-note', 'output_id': span['output_id'],
                                'source_revision_id': span['source_revision_id'], 'span_id': span['id'],
                                'kind': 'textual_note', 'provider': 'Synthetic', 'basis_json': {}, 'details_json': {}})
        with self.assertRaises(sqlite3.IntegrityError):
            save(late, self.db)

if __name__ == '__main__':
    unittest.main()

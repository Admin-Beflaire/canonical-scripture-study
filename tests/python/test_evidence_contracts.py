"""Synthetic SQLite contract checks; no D1/R2 calls or production promotion code."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import unittest

from css_shared import assert_reference, parse_reference, serialize_reference

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / 'tests/conformance/evidence-records.v1.json').read_text())
MANIFEST = json.loads((ROOT / 'schemas/evidence.v1.manifest.json').read_text())
TABLES = MANIFEST['record_tables']


class EvidenceContractsTests(unittest.TestCase):
    def insert(self, record_type, record):
        row = {key: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
               if key.endswith('_json') else value for key, value in record.items()}
        columns = list(row)
        self.db.execute(f"INSERT INTO {TABLES[record_type]} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", list(row.values()))

    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript((ROOT / 'schemas' / MANIFEST['migration']).read_text())
        self.addCleanup(self.db.close)
        for kind, records in FIXTURE['records'].items():
            if kind in ('release', 'release_output', 'release_selection'):
                continue
            for row in records:
                self.insert(kind, row)
        self.db.commit()

    def releases(self):
        for kind in ('release', 'release_output'):
            for row in FIXTURE['records'][kind]:
                self.insert(kind, row)
        self.db.commit()

    def selected_spans(self, release):
        return self.db.execute('SELECT ns.id FROM release_outputs ro JOIN native_spans ns ON ns.output_id=ro.output_id WHERE ro.release_id=? ORDER BY ns.id', (release,)).fetchall()

    def test_migration_is_single_sequence_with_declared_tables_and_indexes(self):
        self.assertEqual(FIXTURE['fixture_version'], 'evidence-contracts/1')
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(tables, set(TABLES.values()))
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(list((ROOT / 'schemas/migrations').glob('*.sql')), [ROOT / 'schemas' / MANIFEST['migration']])
        plan = self.db.execute('EXPLAIN QUERY PLAN SELECT output_id FROM release_outputs WHERE release_id=?', ('release-1',)).fetchall()
        self.assertTrue(any('INDEX' in row[3] for row in plan))
        plan = self.db.execute('EXPLAIN QUERY PLAN SELECT relationship_id FROM relation_members WHERE span_id=?', ('span-a',)).fetchall()
        self.assertTrue(any('relation_members_span' in row[3] for row in plan))

    def test_sql_records_round_trip_decoded_json_without_losing_fields(self):
        for kind, records in FIXTURE['records'].items():
            if kind in ('release', 'release_output', 'release_selection'):
                continue
            fetched = [dict(row) for row in self.db.execute(f'SELECT * FROM {TABLES[kind]}')]
            for row in fetched:
                for key, value in list(row.items()):
                    if key.endswith('_json'):
                        row[key] = json.loads(value)
                    elif key == 'both_hosts_eligible':
                        row[key] = bool(value)
            self.assertCountEqual(fetched, records, kind)

    def test_shared_text_keeps_separate_source_attribution_and_native_identity(self):
        rows = self.db.execute('SELECT ns.id,ns.source_revision_id,sn.attribution,ns.content_id FROM native_spans ns JOIN source_nodes sn ON sn.id=ns.source_revision_id WHERE ns.content_id IS NOT NULL ORDER BY ns.id').fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['content_id'], rows[1]['content_id'])
        self.assertNotEqual(rows[0]['source_revision_id'], rows[1]['source_revision_id'])
        self.assertNotEqual(rows[0]['attribution'], rows[1]['attribution'])
        text = self.db.execute('SELECT * FROM text_payloads').fetchone()
        self.assertEqual(hashlib.sha256(text['exact_text'].encode()).hexdigest(), text['content_id'])
        self.assertEqual(text['exact_text'], 'אְ😀ב')
        for row in FIXTURE['records']['native_span']:
            reference = dict(schema_version='native-reference/1', source_revision_id=row['source_revision_id'], coordinate_version=row['coordinate_version'], segments=row['segments_json'])
            assert_reference(reference)
            self.assertEqual(parse_reference(serialize_reference(reference)), reference)

    def test_source_hierarchy_foreign_keys_and_exact_revision_kind_are_enforced(self):
        row = deepcopy(FIXTURE['records']['source_node'][1])
        row.update(id='wrong-parent', parent_id='synthetic:a:representation')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('source_node', row)
        row.update(id='self-parent', parent_id='self-parent')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('source_node', row)
        self_span = deepcopy(FIXTURE['records']['native_span'][0])
        self_span.update(id='self-parent-span', parent_id='self-parent-span')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('native_span', self_span)
        admission = deepcopy(FIXTURE['records']['admission'][0])
        admission.update(id='bad-admission', source_revision_id='synthetic:a:work')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('admission', admission)
        span = deepcopy(FIXTURE['records']['native_span'][0])
        span.update(id='orphan', output_id='no-output')
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('native_span', span)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE source_nodes SET kind='work',parent_id=NULL WHERE id='synthetic:a:source_revision'")

    def test_output_coverage_precedes_releases_and_is_reused_by_membership(self):
        self.assertEqual(self.db.execute('SELECT count(*) FROM releases').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM coverage').fetchone()[0], 5)
        self.releases()
        for release in ('release-1', 'release-2'):
            rows = self.db.execute('SELECT c.* FROM release_outputs ro JOIN coverage c ON c.output_id=ro.output_id WHERE ro.release_id=?', (release,)).fetchall()
            self.assertTrue(any(row['state'] == 'available' and row['capability'] == 'source_search' for row in rows))
            self.assertEqual({r['state'] for r in rows}, {'available','partial','missing','unresolved'})
        self.assertNotIn('span-range', [r[0] for r in self.selected_spans('release-1')])
        self.assertIn('span-range', [r[0] for r in self.selected_spans('release-2')])
        self.assertEqual(self.db.execute('SELECT count(*) FROM prepared_outputs WHERE id=?', ('shared',)).fetchone()[0], 1)

    def test_ordered_many_endpoint_relationship_and_reverse_lookup(self):
        self.releases()
        members = self.db.execute('SELECT role,ordinal,span_id,correspondence,gap_reason FROM relation_members WHERE relationship_id=? ORDER BY role,ordinal', ('relation-a',)).fetchall()
        self.assertEqual([(r['role'],r['ordinal'],r['span_id']) for r in members], [('from',0,'span-b'),('from',1,'span-a'),('to',0,'span-a'),('to',1,None)])
        self.assertEqual(members[-1]['correspondence'], 'missing')
        self.assertTrue(members[-1]['gap_reason'])
        rows = self.db.execute('SELECT DISTINCT r.id,r.status FROM relation_members m JOIN relationships r ON r.id=m.relationship_id JOIN release_outputs ro ON ro.output_id=r.output_id WHERE m.span_id=? AND ro.release_id=?', ('span-a','release-2')).fetchall()
        self.assertEqual([(r[0],r[1]) for r in rows], [('relation-a','disputed')])

    def test_registered_utf8_body_ranges_and_originals_remain_distinct(self):
        span = FIXTURE['records']['native_span'][2]
        extracted = []
        for index, ref in enumerate(span['body_ranges_json']):
            self.assertEqual(ref['segment_ordinal'], index)
            artifact = self.db.execute('SELECT * FROM artifacts WHERE id=?', (ref['artifact_id'],)).fetchone()
            data = FIXTURE['artifact_text'][ref['artifact_id']].encode('utf-8')
            self.assertEqual(len(data), artifact['byte_count'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), artifact['sha256'])
            start, length = ref['byte_offset'], ref['byte_length']
            part = data[start:start+length]
            self.assertEqual(len(part), length)
            self.assertEqual(hashlib.sha256(part).hexdigest(), ref['sha256'])
            extracted.append(part.decode('utf-8', errors='strict'))
        self.assertEqual(extracted, FIXTURE['expected_range_text'])
        with self.assertRaises(UnicodeDecodeError):
            '😀'.encode()[1:].decode('utf-8', errors='strict')
        self.assertIsNone(self.db.execute("SELECT output_id FROM artifacts WHERE id='original-body'").fetchone()[0])
        for bucket in ('synthetic-first-bucket', 'synthetic-replacement-bucket'):
            resolved = (bucket, self.db.execute("SELECT registered_locator FROM artifacts WHERE id='range-body'").fetchone()[0])
            self.assertEqual(resolved[1], FIXTURE['records']['artifact'][1]['registered_locator'])

    def test_component_redistribution_and_external_references_do_not_claim_admission(self):
        rows = self.db.execute("SELECT component,both_hosts_eligible,public_redistribution FROM admissions WHERE source_revision_id='synthetic:a:source_revision' ORDER BY component").fetchall()
        self.assertEqual([tuple(r) for r in rows], [('annotations',1,'not_allowed'),('scans',0,'unresolved'),('text',1,'allowed')])
        refs = FIXTURE['records']['study_package'][0]['source_refs_json']
        self.assertEqual(refs[1]['availability'], 'external')
        self.assertNotIn('reference', refs[1])
        self.assertNotIn('answer', FIXTURE['records']['study_package'][0])

    def test_only_one_approved_statement_per_release_and_membership_mutation_guards(self):
        self.releases()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('release_output', dict(release_id='release-2',output_id='statement-1'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('release_output', dict(release_id='release-1',output_id='draft-statement'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE character_statements SET status='draft',owner_approval_ref=NULL WHERE output_id='statement-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM character_statements WHERE output_id='statement-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE release_outputs SET output_id='statement-1' WHERE release_id='release-2' AND output_id='new'")
        for release in ('release-1','release-2'):
            self.assertEqual(self.db.execute('SELECT count(*) FROM release_outputs ro JOIN character_statements cs ON cs.output_id=ro.output_id WHERE ro.release_id=? AND cs.status=?',(release,'approved')).fetchone()[0],1)

    def test_immutable_prepared_records_reject_overwrite(self):
        self.releases()
        for sql in (
            "UPDATE text_payloads SET exact_text='changed'",
            "UPDATE artifacts SET registered_locator='changed/key'",
            "UPDATE prepared_outputs SET parameters_json='{}'",
            "UPDATE native_spans SET segments_json='[]'",
            "UPDATE releases SET quality_receipt='changed'",
        ):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)

    def test_singleton_selection_and_failed_candidate_transaction_keep_current(self):
        self.releases()
        self.db.execute("UPDATE release_selection SET current_release_id='release-1' WHERE singleton_id=1")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute("UPDATE release_selection SET current_release_id='release-2',previous_release_id='release-1' WHERE singleton_id=1")
                candidate = deepcopy(FIXTURE['records']['release'][1])
                candidate.update(id='invalid-candidate',quality_receipt='')
                self.insert('release', candidate)
        self.assertEqual(tuple(self.db.execute('SELECT current_release_id,previous_release_id FROM release_selection').fetchone()), ('release-1',None))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO release_selection VALUES(2,NULL,NULL)')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE release_selection SET current_release_id='absent'")
        with self.db:
            self.db.execute("UPDATE release_selection SET current_release_id='release-2',previous_release_id='release-1' WHERE singleton_id=1")
        self.assertEqual(tuple(self.db.execute('SELECT current_release_id,previous_release_id FROM release_selection').fetchone()), ('release-2','release-1'))


if __name__ == '__main__':
    unittest.main()

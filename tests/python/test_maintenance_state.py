"""Constraints of the private Maintenance task tables (synthetic rows only)."""
import json
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[2]
DIGEST = 'a' * 64


class MaintenanceStateTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for migration in sorted((ROOT / 'schemas/migrations').glob('*.sql')):
            self.db.executescript(migration.read_text())

    def tearDown(self):
        self.db.close()

    def task(self, task_id='t1', key='k1', state='queued', kind='prepare'):
        self.db.execute(
            'INSERT INTO maintenance_tasks(id,requester,request_key,instruction,scope_json,basis_digest,revision,state,outcome_json)'
            ' VALUES(?,?,?,?,?,?,1,?,?)',
            (task_id, 'owner@example.invalid', key, 'Prepare the fixture', json.dumps({'kind': kind}), DIGEST, state, '{}'))

    def test_task_identity_revision_and_terminal_guards(self):
        self.task()
        with self.assertRaises(sqlite3.IntegrityError):
            self.task('t2', 'k1')  # requester/key is unique
        with self.assertRaises(sqlite3.IntegrityError):
            self.task('t3', 'k3', kind='promote')  # unknown kind
        with self.assertRaises(sqlite3.IntegrityError):
            self.task('t4', 'k4', state='done')
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'advance by one'):
            self.db.execute("UPDATE maintenance_tasks SET state='paused', revision=3 WHERE id='t1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'immutable'):
            self.db.execute("UPDATE maintenance_tasks SET scope_json='{\"kind\":\"remove\"}', revision=2 WHERE id='t1'")
        self.db.execute("UPDATE maintenance_tasks SET state='cancelled', revision=2 WHERE id='t1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'Finished task'):
            self.db.execute("UPDATE maintenance_tasks SET state='queued', revision=3 WHERE id='t1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'retained'):
            self.db.execute("DELETE FROM maintenance_tasks WHERE id='t1'")

    def test_jobs_need_run_after_intent_and_keep_identity(self):
        self.task()
        insert = 'INSERT INTO maintenance_jobs(task_id,task_revision,unit_id,attempt,kind,input_basis,run_id,state) VALUES(?,?,?,?,?,?,?,?)'
        self.db.execute(insert, ('t1', 1, 'u1', 1, 'prepare', DIGEST, None, 'intended'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('t1', 1, 'u1', 1, 'prepare', DIGEST, None, 'intended'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('t1', 1, 'u2', 1, 'prepare', DIGEST, None, 'running'))  # running needs a run
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(insert, ('missing', 1, 'u3', 1, 'prepare', DIGEST, None, 'intended'))
        self.db.execute("UPDATE maintenance_jobs SET run_id='r1', state='dispatched' WHERE unit_id='u1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'run identity'):
            self.db.execute("UPDATE maintenance_jobs SET run_id='r2' WHERE unit_id='u1'")
        self.db.execute("UPDATE maintenance_jobs SET state='succeeded', result_ref='res' WHERE unit_id='u1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'Finished job'):
            self.db.execute("UPDATE maintenance_jobs SET state='running' WHERE unit_id='u1'")

    def test_exclusions_are_retained(self):
        self.task()
        self.db.execute("INSERT INTO maintenance_exclusions VALUES('src-a','owner-decision:1','t1',1,1)")
        self.db.execute("UPDATE maintenance_exclusions SET active=0, revision=2 WHERE source_or_component_id='src-a'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'retained'):
            self.db.execute("DELETE FROM maintenance_exclusions")


if __name__ == '__main__':
    unittest.main()

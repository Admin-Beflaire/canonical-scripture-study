"""DP-04 Stage 3: durable unit resume and bounded failure tests (synthetic only)."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest

from css_preparation.executor import ControlState, UnitNotRunnable
from css_preparation.executor.candidate import CandidateStore
from css_preparation.executor.checkpoints import (
    CheckpointStore, RetryableUnitError, StopWork, run_checkpointed_unit,
)
from css_preparation.prepare.records import RecordError, decoded, TABLES
from preparation_fixture import COORDINATES, database, evidence_a, text_a

FIXTURE = json.loads((Path(__file__).resolve().parents[1] /
                     'conformance/maintenance-jobs.v1.json').read_text())


class CheckpointStageThree(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.blobs = {}
        self.checkpoint_blobs = {}
        self.work_count = 0
        self.selection = [tuple(r) for r in self.db.execute('SELECT * FROM release_selection')]
        self.storage = CandidateStore(self.put, self.read, self.write, self.find, self.all_rows)
        self.checkpoints = CheckpointStore(self.save_checkpoint, self.load_checkpoint)
        self.state = None
        self.job = dict(FIXTURE['valid']['job_input'][0])
        self.job['input_refs'] = [{'kind': 'source_revision', 'id': 'synthetic:a:revision-1'}]
        self.job['native_extent'] = {'unit_ids': [u for u, _ in text_a().units],
                                     'coordinate_version': COORDINATES}

    def put(self, key, data):
        if key in self.blobs and self.blobs[key] != data:
            raise RecordError('Cannot overwrite immutable artifact')
        self.blobs[key] = bytes(data)

    def read(self, key):
        return self.blobs[key]

    def write(self, statements):
        with self.db:
            for sql, values in statements:
                self.db.execute(sql, values)

    def find(self, kind, identifier):
        table = {'prepared_output': 'prepared_outputs', 'artifact': 'artifacts'}[kind]
        rows = decoded(self.db.execute(f'SELECT * FROM {table} WHERE id = ?',
                                       (identifier,)).fetchall())
        return rows[0] if rows else None

    def all_rows(self, kind, *_):
        return decoded(self.db.execute('SELECT * FROM ' + TABLES[kind]).fetchall())

    def save_checkpoint(self, content):
        sha = hashlib.sha256(content).hexdigest()
        ref = {'artifact_id': 'checkpoint:' + sha[:32], 'sha256': sha,
               'byte_count': len(content)}
        previous = self.checkpoint_blobs.setdefault(ref['artifact_id'], bytes(content))
        if previous != content:
            raise RecordError('Different checkpoint at same key')
        return ref

    def load_checkpoint(self, ref):
        return self.checkpoint_blobs[ref['artifact_id']]

    def build(self, _):
        self.work_count += 1
        return evidence_a()

    def invoke(self, *, job=None, builder=None, checkpoint_store=None,
               max_retries=1, registry=None, control=None):
        job = self.job if job is None else job
        raw = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        self.state = ControlState(
            job['task_id'], job['task_revision'] + 1, 'running', job['basis_digest'],
            job['unit_id'], job['attempt'], job['task_revision'],
            hashlib.sha256(raw.encode('utf-8')).hexdigest(), 'run-9', 'dispatched')
        def reader(*_):
            return self.state if control is None else control()
        handler = builder or self.build
        return run_checkpointed_unit(raw, run_id='run-9', read_control=reader,
                                     registered=registry or (lambda _: True),
                                     acquire=handler, prepare=handler, quality=handler,
                                     storage=self.storage,
                                     checkpoints=checkpoint_store or self.checkpoints,
                                     max_retries=max_retries)

    def test_checkpoint_is_durable_and_resume_avoids_duplicate_work(self):
        first = self.invoke()
        self.assertEqual(first.state, 'checkpointed')
        self.assertEqual(first.completed_extent, self.job['native_extent'])
        self.assertEqual(first.remaining_extent, {})
        self.assertEqual(first.cursor, self.job['unit_id'])
        self.assertEqual(first.saved.output_ids, tuple(evidence_a().output_ids()))
        self.assertEqual(self.work_count, 1)
        self.assertIsNotNone(first.checkpoint_ref)
        checkpoint = json.loads(self.load_checkpoint(first.checkpoint_ref))
        self.assertEqual(checkpoint['identity']['recipe_revision'], self.job['recipe_revision'])
        self.assertEqual(checkpoint['identity']['attempt'], self.job['attempt'])
        self.assertEqual(checkpoint['saved']['output_ids'], list(first.saved.output_ids))
        passed = []
        replay = self.invoke(job={**self.job, 'checkpoint_ref': first.checkpoint_ref},
                             builder=lambda _: self.fail('replay rebuilt a verified unit'),
                             registry=lambda r: passed.append(r['id']) or True)
        self.assertEqual(replay.saved, first.saved)
        self.assertEqual(replay.checkpoint_ref, first.checkpoint_ref)
        self.assertIn(first.checkpoint_ref['artifact_id'], passed)
        self.assertEqual([tuple(r) for r in self.db.execute('SELECT * FROM release_selection')],
                         self.selection)

    def test_interruption_after_save_before_report_can_retry_idempotently(self):
        interrupts = [True]
        def interrupted_save(data):
            ref = self.save_checkpoint(data)
            if interrupts and interrupts.pop():
                raise RetryableUnitError('synthetic interrupted callback')
            return ref
        result = self.invoke(checkpoint_store=replace(self.checkpoints, save=interrupted_save))
        self.assertEqual(result.state, 'checkpointed')
        self.assertEqual(self.work_count, 2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)
        replay = self.invoke(job={**self.job, 'checkpoint_ref': result.checkpoint_ref},
                             builder=lambda _: self.fail('must reuse saved unit'))
        self.assertEqual(replay.state, 'checkpointed')
        self.assertEqual(self.work_count, 2)

    def test_changed_basis_or_attempt_rebuilds_instead_of_reusing_old_checkpoint(self):
        original = self.invoke()
        for changed in ({'recipe_revision': 'recipe-2'},
                        {'manifest_revision': 'manifest-2'},
                        {'attempt': self.job['attempt'] + 1},
                        {'basis_digest': 'a' * 64}):
            with self.subTest(changed=changed):
                job = {**self.job, **changed, 'checkpoint_ref': original.checkpoint_ref}
                before = self.work_count
                result = self.invoke(job=job)
                self.assertEqual(result.state, 'checkpointed')
                self.assertEqual(self.work_count, before + 1)

    def test_corrupt_or_missing_saved_artifact_never_reused_as_complete(self):
        result = self.invoke()
        artifact_ref = result.saved.artifact_refs[0]
        locator = self.find('artifact', artifact_ref['artifact_id'])['registered_locator']
        self.blobs[locator] = b'damaged'
        check = self.invoke(job={**self.job, 'checkpoint_ref': result.checkpoint_ref})
        self.assertEqual(check.state, 'failed')
        self.assertEqual(check.completed_extent, {})
        self.assertEqual(check.remaining_extent, self.job['native_extent'])
        self.assertEqual(check.diagnostics, ('invalid_or_unavailable_output',))
        self.assertEqual([tuple(r) for r in self.db.execute('SELECT * FROM release_selection')],
                         self.selection)

    def test_missing_saved_coverage_disables_replay(self):
        result = self.invoke()
        def incomplete(kind, *_):
            rows = self.all_rows(kind)
            return [] if kind == 'coverage' else rows
        self.storage = replace(self.storage, read_rows=incomplete)
        replay = self.invoke(job={**self.job, 'checkpoint_ref': result.checkpoint_ref})
        self.assertEqual(replay.state, 'failed')
        self.assertEqual(replay.diagnostics, ('invalid_or_unavailable_output',))

    def test_rejects_different_revision_or_extent_before_persistence(self):
        changed = {**self.job, 'input_refs': [{'kind': 'source_revision', 'id': 'other-revision'}]}
        rejected = self.invoke(job=changed)
        self.assertEqual(rejected.state, 'failed')
        self.assertEqual(rejected.completed_extent, {})
        changed = {**self.job, 'native_extent': {'unit_ids': ['unrelated']}}
        rejected = self.invoke(job=changed)
        self.assertEqual(rejected.state, 'failed')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)

    def test_tampered_checkpoint_bytes_fail_closed(self):
        original = self.invoke()
        self.checkpoint_blobs[original.checkpoint_ref['artifact_id']] = b'wrong'
        result = self.invoke(job={**self.job, 'checkpoint_ref': original.checkpoint_ref})
        self.assertEqual(result.state, 'failed')
        self.assertEqual(result.completed_extent, {})
        self.assertEqual(result.diagnostics, ('invalid_or_unavailable_output',))

    def test_paused_or_cancelled_task_stops_without_new_candidate_writes(self):
        for state in ('paused', 'cancelled', 'superseded'):
            with self.subTest(state=state):
                with self.assertRaises(UnitNotRunnable):
                    self.invoke(control=lambda: replace(self.state, task_state=state),
                                builder=lambda _: self.fail('task not eligible'))
                self.assertEqual(self.work_count, 0)
        def change_state(_):
            self.state = replace(self.state, task_state='paused', task_revision=3)
            return evidence_a()
        with self.assertRaises(UnitNotRunnable):
            self.invoke(builder=change_state)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)

    def test_retry_rechecks_control_and_avoids_rerunning_cancelled_unit(self):
        calls = []
        def transient(_):
            calls.append('called')
            self.state = replace(self.state, task_state='cancelled', task_revision=3)
            raise RetryableUnitError('synthetic timeout')
        result = self.invoke(builder=transient)
        self.assertEqual(result.state, 'failed')
        self.assertEqual(result.diagnostics, ('stopped',))
        self.assertEqual(calls, ['called'])
        self.assertIsNone(result.checkpoint_ref)

    def test_bounded_transient_retry_and_refusal_limit_diagnostics(self):
        attempts = []
        def once(_):
            attempts.append(1)
            if len(attempts) == 1:
                raise RetryableUnitError('retry once')
            return evidence_a()
        result = self.invoke(builder=once)
        self.assertEqual(result.state, 'checkpointed')
        self.assertEqual(len(attempts), 2)
        for reason in ('quota', 'refused', 'missing_dependency', 'limit'):
            with self.subTest(reason=reason):
                def stop(_):
                    raise StopWork(reason)
                failed = self.invoke(builder=stop)
                self.assertEqual(failed.diagnostics, (reason,))
                self.assertEqual(failed.remaining_extent, self.job['native_extent'])
                self.assertIsNone(failed.saved)
        with self.assertRaises(ValueError):
            self.invoke(max_retries=4)

    def test_exhausted_transient_and_permanent_failure_claim_no_progress(self):
        calls = []
        def never(_):
            calls.append(1)
            raise RetryableUnitError('unavailable')
        failed = self.invoke(builder=never, max_retries=2)
        self.assertEqual(failed.diagnostics, ('transient_exhausted',))
        self.assertEqual(len(calls), 3)
        self.assertEqual(failed.completed_extent, {})
        def permanent(_):
            raise RecordError('contains secret details; never copy to diagnostics')
        failed = self.invoke(builder=permanent)
        self.assertEqual(failed.diagnostics, ('invalid_or_unavailable_output',))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

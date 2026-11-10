"""DP-04 Stage 1: synthetic gates before a single preparation unit executes."""
from dataclasses import replace
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

from css_preparation.contracts import ContractError
from css_preparation.executor import ControlState, UnitNotRunnable, execute_unit

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / 'conformance/maintenance-jobs.v1.json').read_text())


def basis(job):
    return hashlib.sha256(json.dumps(job, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


class ExecutorEntryTests(unittest.TestCase):
    def setUp(self):
        self.job = FIXTURE['valid']['job_input'][0]
        self.state = ControlState(
            task_id=self.job['task_id'], task_revision=2, task_state='running',
            task_basis_digest=self.job['basis_digest'], unit_id=self.job['unit_id'],
            attempt=self.job['attempt'], job_revision=self.job['task_revision'],
            job_input_basis=basis(self.job), run_id='run-9', job_state='dispatched')
        self.observed = []

    def invoke(self, job=None, state=None, run_id='run-9', registered=None):
        self.observed = []
        return execute_unit(json.dumps(self.job if job is None else job, sort_keys=True, ensure_ascii=False,
                                       separators=(',', ':')), run_id=run_id,
                            read_control=lambda *_: self.state if state is None else state,
                            registered=registered or (lambda ref: self.observed.append(ref['id']) or True),
                            process=lambda entry: self.observed.append('processed') or entry['kind'])

    def test_contract_fixtures_remain_authoritative(self):
        for job in FIXTURE['valid']['job_input']:
            self.assertEqual(self.invoke(job=job, state=replace(self.state,
                task_id=job['task_id'], unit_id=job['unit_id'], attempt=job['attempt'],
                job_revision=job['task_revision'], task_revision=job['task_revision'] + 1,
                task_basis_digest=job['basis_digest'], job_input_basis=basis(job))), job['kind'])
        for job in FIXTURE['invalid']['job_input']:
            with self.assertRaises(ContractError):
                self.invoke(job=job)

    def test_valid_run_requires_registered_refs_before_processing(self):
        self.assertEqual(self.invoke(), 'prepare')
        self.assertEqual(self.observed, ['src-rev-1', 'art-0', 'art-1', 'processed'])
        # Dispatch from an already-running task does not increment its revision.
        self.assertEqual(self.invoke(state=replace(self.state, task_revision=1)), 'prepare')

    def test_gate_denies_non_running_and_stale_task(self):
        for state in ('queued', 'paused', 'blocked', 'checked', 'cancelled', 'superseded', 'completed'):
            with self.subTest(state=state), self.assertRaises(UnitNotRunnable):
                self.invoke(state=replace(self.state, task_state=state))
            self.assertEqual(self.observed, [])
        for revision in (0, 3, 4):
            with self.subTest(revision=revision), self.assertRaises(UnitNotRunnable):
                self.invoke(state=replace(self.state, task_revision=revision))
            self.assertEqual(self.observed, [])

    def test_dispatch_identity_basis_and_status_are_required(self):
        variants = (
            dict(task_id='other'), dict(unit_id='other'), dict(attempt=2),
            dict(job_revision=2), dict(task_basis_digest='a' * 64),
            dict(job_input_basis='a' * 64), dict(run_id='other'),
            dict(job_state='intended'), dict(job_state='succeeded'),
        )
        for changes in variants:
            with self.subTest(changes=changes), self.assertRaises(UnitNotRunnable):
                self.invoke(state=replace(self.state, **changes))
            self.assertEqual(self.observed, [])
        with self.assertRaises(UnitNotRunnable):
            self.invoke(run_id='run-9\n')

    def test_exact_dispatch_inputs_not_just_task_digest(self):
        modified = dict(self.job, manifest_revision='manifest-2')
        with self.assertRaisesRegex(UnitNotRunnable, 'inputs changed'):
            self.invoke(job=modified)
        self.assertEqual(self.observed, [])

    def test_input_digest_uses_controls_exact_canonical_json_bytes(self):
        job = deepcopy(self.job)
        job['constraints'] = {'limit': 0.000001}
        # JSON.stringify writes 0.000001; Python json.dumps writes 1e-06.
        raw = json.dumps(job, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        self.assertIn('1e-06', raw)
        control_bytes = raw.replace('1e-06', '0.000001')
        digest = hashlib.sha256(control_bytes.encode('utf-8')).hexdigest()
        seen = []
        result = execute_unit(control_bytes, run_id='run-9',
                              read_control=lambda *_: replace(self.state, job_input_basis=digest),
                              registered=lambda ref: True,
                              process=lambda entry: seen.append(entry['kind']) or entry['kind'])
        self.assertEqual(result, 'prepare')
        self.assertEqual(seen, ['prepare'])
        # A differently serialized payload, even with the same fields, was not dispatched.
        with self.assertRaisesRegex(UnitNotRunnable, 'inputs changed'):
            execute_unit(raw, run_id='run-9',
                         read_control=lambda *_: replace(self.state, job_input_basis=digest),
                         registered=lambda ref: True,
                         process=lambda entry: self.fail('modified wire input ran'))

    def test_missing_registered_refs_prevent_processing(self):
        for rejected_id in ('src-rev-1', 'art-0', 'art-1'):
            with self.subTest(rejected_id=rejected_id), self.assertRaises(UnitNotRunnable):
                self.invoke(registered=lambda ref, rid=rejected_id: ref['id'] != rid)
            self.assertNotIn('processed', self.observed)

    def test_checkpoint_registration_is_required(self):
        job = FIXTURE['valid']['job_input'][1]
        state = replace(self.state, job_input_basis=basis(job))
        seen = []
        with self.assertRaises(UnitNotRunnable):
            self.invoke(job=job, state=state, registered=lambda ref: seen.append(ref['id']) or len(seen) < 4)
        self.assertEqual(seen, ['src-rev-1', 'art-0', 'art-1', 'art-1'])
        self.assertNotIn('processed', self.observed)


if __name__ == '__main__':
    unittest.main()

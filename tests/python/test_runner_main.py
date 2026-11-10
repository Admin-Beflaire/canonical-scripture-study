"""GH-04 step 3: runner entry against loopback Cloudflare and Control doubles (synthetic only)."""
import contextlib
import functools
import hashlib
import io
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest import mock

from css_preparation.contracts import ContractError, contract_errors
from css_preparation.prepare.records import RecordError, RecordSet
from css_preparation.runner import __main__ as runner
from css_preparation.runner.cloudflare import CloudflareConfig, CloudflareStorage
from css_preparation.runner.control import ControlClient, ControlConfig
from css_preparation.runner.recipes import RECIPES, Recipe
from css_preparation.runner.web import Origin
from preparation_fixture import evidence_a, text_a
from runner_doubles import LoopbackApi

ROOT = Path(__file__).resolve().parents[2]
WIRE = json.loads((ROOT / 'tests/conformance/dp04-control-wire.v1.json').read_text(encoding='utf-8'))
MARKER = 'PRIVATE-MARKER-7f3a'
COMMIT = 'c' * 40
RUN_ID = '987654321'


def canonical(job):
    return json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.evidence = evidence_a()
        evidence_row = self.evidence.rows('prepared_output')[0]
        self.output_id = evidence_row['id']
        self.extent = evidence_row['native_extent_json']
        self.revision = evidence_row['input_revisions_json'][0]
        # Acquisition saves source identities before preparation; seed them here.
        seed = RecordSet()
        for row in self.evidence.rows('source_node'):
            seed.add('source_node', row)
        with self.api.db:
            for sql, params in seed.statements():
                self.api.db.execute(sql, params)
        self.task_state = 'running'
        self.results = []
        self.reply = (200, {'status': 'accepted', 'eligible': True, 'state': 'succeeded'})
        self.api.control_handler = self.control
        self.storage = CloudflareStorage(CloudflareConfig('acct', 'db', 'bucket', 'synthetic-token',
                                                          Origin(self.api.origin)))
        self.client = ControlClient(ControlConfig(Origin(self.api.origin), 'synthetic-id', 'synthetic-secret'),
                                    sleep=lambda _: None)
        self.initial_selection = self.selection()
        self.recipe = Recipe(prepare=lambda job, storage: self.evidence,
                             read_source=lambda revision, storage: text_a())

    def selection(self):
        return [tuple(row) for row in self.api.db.execute('SELECT * FROM release_selection')]

    def job(self, kind='prepare', **changes):
        job = deepcopy(WIRE['job_input'])
        job.update(task_id='task-gh04', unit_id=f'unit-{kind}', kind=kind, native_extent=dict(self.extent),
                   input_refs=[{'kind': 'source_revision', 'id': self.revision}], dependency_refs=[],
                   required_capabilities=['source_context'] if kind == 'quality' else [],
                   checkpoint_ref=None, constraints={})
        job.update(changes)
        self.current = canonical(job)
        return self.current

    def control(self, method, path, headers, body):
        request = json.loads(body)
        if path == '/internal/jobs/state':
            job = json.loads(self.current)
            # The run names itself and the digest of the exact bytes it holds.
            self.assertEqual(request['run_id'], RUN_ID)
            self.assertEqual(request['job_input_basis'], hashlib.sha256(self.current.encode('utf-8')).hexdigest())
            return 200, {'task_id': job['task_id'], 'task_revision': job['task_revision'] + 1,
                         'task_state': self.task_state, 'task_basis_digest': job['basis_digest'],
                         'unit_id': job['unit_id'], 'attempt': job['attempt'], 'job_revision': job['task_revision'],
                         'job_input_basis': hashlib.sha256(self.current.encode('utf-8')).hexdigest(),
                         'run_id': RUN_ID, 'job_state': 'dispatched'}
        self.results.append(request)
        return self.reply

    def run_job(self, raw, kind='prepare'):
        with mock.patch.dict(RECIPES, {'recipe-1': self.recipe}):
            return runner.run_job(raw, kind, run_id=RUN_ID, control=self.client, storage=self.storage)

    def test_prepare_unit_saves_candidate_checkpoint_and_valid_result(self):
        result = self.run_job(self.job())
        self.assertEqual(contract_errors('job_result', result), [])
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['remaining_extent'], {})
        self.assertTrue(result['output_refs'])
        self.assertTrue(result['checkpoint_ref']['artifact_id'].startswith('checkpoint:'))
        self.assertIsNotNone(self.storage.read_row('prepared_output', self.output_id))
        self.assertIn(f"prepared/checkpoints/{result['checkpoint_ref']['sha256']}.json", self.api.objects)
        # Preparation never selects data: selection unchanged, no release rows.
        self.assertEqual(self.selection(), self.initial_selection)
        self.assertEqual(self.api.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)

    def test_unknown_recipe_and_missing_module_fail_without_writes(self):
        with mock.patch.dict(RECIPES, {}, clear=True):
            result = runner.run_job(self.job(), 'prepare', run_id=RUN_ID, control=self.client, storage=self.storage)
        self.assertEqual((result['state'], result['diagnostics'][0]['code']), ('failed', 'no_registered_recipe'))
        self.recipe = Recipe()
        result = self.run_job(self.job())
        self.assertEqual(result['diagnostics'][0]['code'], 'no_registered_recipe')
        self.assertEqual(self.api.batches, [])

    def test_paused_or_cancelled_task_runs_nothing(self):
        self.task_state = 'cancelled'
        result = self.run_job(self.job())
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual(self.api.batches, [])

    def test_workflow_kind_must_match_dispatched_kind(self):
        with self.assertRaises(ContractError):
            self.run_job(self.job('prepare'), kind='quality')

    def test_quality_reads_candidate_from_control_constraints(self):
        self.run_job(self.job())
        result = self.run_job(self.job('quality', constraints={'candidate': {'added': [self.output_id]}}),
                              kind='quality')
        self.assertEqual(result['state'], 'succeeded', result['diagnostics'])
        receipt = result['quality_receipt_ref']
        self.assertIn(f"prepared/receipts/{receipt['sha256']}.json", self.api.objects)
        for constraints in ({}, {'candidate': {'added': ['synthetic:not-saved']}}, {'candidate': {'added': 'x'}}):
            result = self.run_job(self.job('quality', constraints=constraints), kind='quality')
            self.assertEqual(result['state'], 'failed')

    def environ(self, raw):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        event = Path(holder.name) / 'event.json'
        event.write_text(json.dumps({'inputs': {'job': raw}}), encoding='utf-8')
        return {'GITHUB_EVENT_PATH': str(event), 'GITHUB_RUN_ID': RUN_ID, 'GITHUB_SHA': COMMIT,
                'CONTROL_ORIGIN': self.api.origin, 'PREPARATION_ACCESS_CLIENT_ID': 'synthetic-id',
                'PREPARATION_ACCESS_CLIENT_SECRET': 'synthetic-secret', 'CLOUDFLARE_ACCOUNT_ID': 'acct',
                'D1_DATABASE_ID': 'db', 'R2_BUCKET': 'bucket', 'PREPARATION_CLOUDFLARE_TOKEN': 'synthetic-token'}

    def main(self, environ, kind='prepare', mode=None):
        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / 'status.txt'
            config = functools.partial(CloudflareConfig, api=Origin(self.api.origin))
            with mock.patch.object(runner, 'CloudflareConfig', config), \
                    mock.patch.dict(RECIPES, {'recipe-1': self.recipe}), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = runner.main((mode or ['--kind', kind]) + ['--status', str(status)], environ)
            return code, status.read_text(encoding='utf-8'), out.getvalue() + err.getvalue()

    def test_validate_routes_only_the_enumerated_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output.txt'
            environ = {'GITHUB_EVENT_PATH': self.environ(self.job('quality'))['GITHUB_EVENT_PATH'],
                       'GITHUB_OUTPUT': str(output)}
            code, status, printed = self.main(environ, mode=['--validate'])
            self.assertEqual((code, output.read_text()), (0, 'kind=quality\n'))
            self.assertEqual(status, 'Preparation job accepted for the quality job.\n')
            self.assertEqual(printed, '')
            for text in ('{"kind":"prepare; rm -rf /"}', 'not json at all'):
                bad = {**environ, 'GITHUB_EVENT_PATH': self.environ(text)['GITHUB_EVENT_PATH']}
                code, status, _ = self.main(bad, mode=['--validate'])
                self.assertEqual((code, status, output.read_text()),
                                 (1, runner.PUBLIC['invalid'] + '\n', 'kind=quality\n'))

    def test_main_submits_result_and_prints_only_fixed_status(self):
        code, status, printed = self.main(self.environ(self.job()))
        self.assertEqual(code, 0)
        self.assertEqual(status, 'Preparation prepare unit finished: succeeded.\nControl accepted the result.\n')
        self.assertEqual(printed, '')
        [sent] = self.results
        self.assertEqual(sent['commit'], COMMIT)
        self.assertEqual(sent['result']['run_id'], RUN_ID)

    def test_private_markers_reach_only_the_private_result(self):
        def leak(job, storage):
            raise RecordError(f'{MARKER} source wording and inventory detail')
        self.recipe = Recipe(prepare=leak)
        raw = self.job(unit_id=f'unit-{MARKER}')
        code, status, printed = self.main(self.environ(raw))
        self.assertEqual(code, 1)
        for public in (status, printed):
            self.assertNotIn(MARKER, public)
            self.assertNotIn('synthetic-secret', public)
            self.assertNotIn('synthetic-token', public)
        self.assertIn(MARKER, json.dumps(self.results[0]['result']))  # private Control record only

    def test_unexpected_crash_is_reported_privately(self):
        def crash(job, storage):
            raise RuntimeError(MARKER)
        self.recipe = Recipe(prepare=crash)
        code, status, printed = self.main(self.environ(self.job()))
        self.assertEqual(code, 1)
        self.assertNotIn(MARKER, status + printed)
        [sent] = self.results
        self.assertEqual(sent['result']['state'], 'failed')
        self.assertEqual(sent['result']['diagnostics'][0]['code'], 'runner_error')

    def test_configuration_invalid_job_and_undelivered_result(self):
        environ = self.environ(self.job())
        for missing in runner.REQUIRED:
            code, status, _ = self.main({k: v for k, v in environ.items() if k != missing})
            self.assertEqual((code, status), (1, runner.PUBLIC['config'] + '\n'))
        code, status, _ = self.main({**environ, 'GITHUB_SHA': 'main'})
        self.assertEqual(status, runner.PUBLIC['config'] + '\n')
        code, status, _ = self.main(self.environ('{"script":"rm -rf /"}'))
        self.assertEqual((code, status), (1, runner.PUBLIC['invalid'] + '\n'))
        for text in ('not json at all', '{"truncated": ', ''):
            code, status, _ = self.main(self.environ(text))
            self.assertEqual((code, status), (1, runner.PUBLIC['invalid'] + '\n'))
        code, status, _ = self.main(self.environ(self.job('quality')))  # kind mismatch with --kind prepare
        self.assertEqual((code, status), (1, runner.PUBLIC['invalid'] + '\n'))
        self.assertEqual(self.results, [])
        code, status, _ = self.main({**environ, 'GITHUB_EVENT_PATH': '/nonexistent/event.json'})
        self.assertEqual((code, status), (1, runner.PUBLIC['invalid'] + '\n'))
        self.reply = (503, {})
        code, status, _ = self.main(environ)
        self.assertEqual(code, 1)
        self.assertTrue(status.endswith(runner.PUBLIC['undelivered'] + '\n'))
        self.reply = (200, {'status': 'rejected', 'reason': 'run does not match the dispatch'})
        code, status, _ = self.main(self.environ(self.job(unit_id='unit-again')))
        self.assertEqual(code, 1)
        self.assertTrue(status.endswith('Control rejected the result.\n'))


if __name__ == '__main__':
    unittest.main()

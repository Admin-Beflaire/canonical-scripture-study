"""GH-04 step 2: Control internal-job client against the shared wire fixture."""
import json
import unittest
from pathlib import Path

from css_preparation.contracts import job_result, parse_job_input
from css_preparation.runner.control import RESULT_PATH, STATE_PATH, ControlClient, ControlConfig
from css_preparation.runner.web import Origin, ProviderError
from runner_doubles import LoopbackApi

ROOT = Path(__file__).resolve().parents[2]
WIRE = json.loads((ROOT / 'tests/conformance/internal-jobs.v1.json').read_text(encoding='utf-8'))
JOB = parse_job_input(json.loads((ROOT / 'tests/conformance/dp04-control-wire.v1.json').read_text())['canonical_json'])
COMMIT = 'c' * 40


def result():
    return job_result(JOB, run_id='1234567890', completed_extent={}, remaining_extent=dict(JOB['native_extent']),
                      output_refs=[], coverage_refs=[], checkpoint_ref=None, quality_receipt_ref=None,
                      state='failed', diagnostics=[{'code': 'synthetic', 'message': 'synthetic'}])


class ControlClientTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.calls = []
        self.replies = []

        def handler(method, path, headers, body):
            # HTTP header names are case-insensitive; compare them in lower case.
            self.calls.append((method, path, {k.lower(): v for k, v in headers.items()}, json.loads(body)))
            return self.replies.pop(0)
        self.api.control_handler = handler
        self.sleeps = []
        self.client = ControlClient(ControlConfig(Origin(self.api.origin), 'synthetic-id', 'synthetic-secret'),
                                    sleep=self.sleeps.append)

    def test_paths_and_service_token_headers_follow_fixture(self):
        self.assertEqual((STATE_PATH, RESULT_PATH), (WIRE['state']['path'], WIRE['result']['path']))
        self.replies = [(200, WIRE['state']['response_200'])]
        state = self.client.read_state(**WIRE['state']['request'])
        self.assertEqual(state.task_state, 'running')
        method, path, headers, body = self.calls[0]
        self.assertEqual((method, path, body), ('POST', STATE_PATH, WIRE['state']['request']))
        self.assertEqual(headers['cf-access-client-id'], 'synthetic-id')
        self.assertEqual(headers['cf-access-client-secret'], 'synthetic-secret')
        self.assertNotIn('authorization', headers)
        # urllib's default agent is blocked by the zone's Browser Integrity Check.
        self.assertEqual(headers['user-agent'], 'canonical-scripture-study-preparation')

    def test_missing_dispatch_and_malformed_state(self):
        self.replies = [(404, {}), (200, {**WIRE['state']['response_200'], 'extra': 1}),
                        (200, {**WIRE['state']['response_200'], 'attempt': True})]
        self.assertIsNone(self.client.read_state('t', 'u', 1, run_id='1', job_input_basis='b' * 64))
        for _ in range(2):
            with self.assertRaises(ProviderError):
                self.client.read_state('t', 'u', 1, run_id='1', job_input_basis='b' * 64)

    def test_result_submission_retries_transient_only(self):
        self.replies = [(503, {}), (200, WIRE['result']['response_200'][0])]
        self.assertEqual(self.client.submit_result(result(), COMMIT)['status'], 'accepted')
        self.assertEqual(self.sleeps, [1])
        self.assertEqual(self.calls[-1][3], {'result': result(), 'commit': COMMIT})
        self.replies = [(400, {})]
        with self.assertRaises(ProviderError):
            self.client.submit_result(result(), COMMIT)
        self.replies = [(503, {})] * 3
        with self.assertRaises(ProviderError):
            self.client.submit_result(result(), COMMIT)
        self.replies = [(200, {'status': 'maybe'})]
        with self.assertRaises(ProviderError):
            self.client.submit_result(result(), COMMIT)

    def test_invalid_result_or_commit_never_sent(self):
        for bad_result, commit in ((result(), 'main'), ({**result(), 'state': 'promoted'}, COMMIT)):
            with self.assertRaises(ValueError):
                self.client.submit_result(bad_result, commit)
        self.assertEqual(self.calls, [])

    def test_redirect_never_forwards_service_token(self):
        self.api.redirect_once = True
        with self.assertRaisesRegex(ProviderError, 'Redirect refused'):
            self.client.read_state('t', 'u', 1, run_id='1', job_input_basis='b' * 64)
        self.assertEqual(len(self.api.requests), 1)
        for value in ('', 'a b'):
            with self.assertRaises(ValueError):
                ControlConfig(Origin(self.api.origin), value, 'secret')


if __name__ == '__main__':
    unittest.main()

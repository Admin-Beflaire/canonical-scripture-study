import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

with patch.dict(sys.modules, {'platform_state': types.ModuleType('platform_state')}):
    path = Path(__file__).resolve().parents[2] / 'infrastructure/github/diagnose_failed_state.py'
    spec = importlib.util.spec_from_file_location('diagnose_failed_state', path)
    diagnostic = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(diagnostic)


class DiagnosticTest(unittest.TestCase):
    def fixture(self, state):
        data = json.dumps(state).encode()
        receipt = json.dumps({'key': 'cloudflare', 'run': diagnostic.RUN,
                              'outcome': 'uncertain', 'bytes': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()}).encode()
        return receipt, data

    def test_reports_fixed_categories_without_private_log_or_state(self):
        receipt, state = self.fixture({'resources': []})
        result = diagnostic.summarize(receipt, state,
                    b'=== apply ===\nError: Authentication error: secret-should-not-appear')
        self.assertTrue(result['state_matches_receipt'])
        self.assertFalse(result['state_contains_kv_resource'])
        self.assertTrue(result['error_categories']['authentication_or_authorization'])
        self.assertNotIn('secret-should-not-appear', json.dumps(result))

    def test_plan_failure_is_reported_when_apply_did_not_run(self):
        receipt, state = self.fixture({'resources': []})
        result = diagnostic.summarize(receipt, state,
                    b'=== plan ===\nError: permission denied: private-plan-detail')
        self.assertTrue(result['plan_log_present'])
        self.assertFalse(result['apply_log_present'])
        self.assertTrue(result['error_categories']['authentication_or_authorization'])
        self.assertNotIn('private-plan-detail', json.dumps(result))

    def test_detects_existing_kv_and_rejects_tampered_state(self):
        receipt, state = self.fixture({'resources': [{'type': 'cloudflare_workers_kv_namespace',
                   'name': 'verified_word_cache', 'instances': [{}]}]})
        self.assertTrue(diagnostic.summarize(receipt, state, b'')['state_contains_kv_resource'])
        with self.assertRaises(ValueError):
            diagnostic.summarize(receipt, state + b' ', b'')


if __name__ == '__main__':
    unittest.main()

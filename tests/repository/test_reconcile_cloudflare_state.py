"""The recovery preserves the failed attempt and rejects the wrong namespace."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from tests.repository.test_platform_state import FakePrivateRelease, state

ROOT = Path(__file__).resolve().parents[2]
with patch.dict(sys.modules, {'platform_state': state}):
    spec = importlib.util.spec_from_file_location('reconcile_cloudflare_state', ROOT / 'infrastructure/github/reconcile_cloudflare_state.py')
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def test_only_computed_database_metadata_can_differ(self):
        before = {'name': 'css-data-main', 'account_id': 'account', 'file_size': 1, 'version': 'production'}
        after = {'name': 'css-data-main', 'account_id': 'account', 'file_size': None, 'version': None}
        change = {'address': 'cloudflare_d1_database.data', 'mode': 'managed', 'change': {
            'actions': ['update'], 'before': before, 'after': after,
            'after_unknown': {'file_size': True, 'version': True}}}
        recovery.verify_plan({'resource_changes': [change]})
        change['change']['after']['name'] = 'different'
        with self.assertRaises(state.StateError):
            recovery.verify_plan({'resource_changes': [change]})
        change['change']['after']['name'] = 'css-data-main'
        change['change']['actions'] = ['delete', 'create']
        with self.assertRaises(state.StateError):
            recovery.verify_plan({'resource_changes': [change]})

    def test_preserves_failed_receipt_and_checks_namespace(self):
        fake = FakePrivateRelease()
        with patch.object(state, 'request', side_effect=fake.request), tempfile.TemporaryDirectory() as tmp:
            fake.release = {'id': 1}
            original = json.dumps({'version': 4, 'lineage': 'same', 'serial': 1, 'resources': []}).encode()
            start, snapshot, receipt = state.names('cloudflare', recovery.FAILED)
            state.upload(fake.release, start, b'{}')
            state.upload(fake.release, snapshot, original)
            failed = {'key': 'cloudflare', 'run': recovery.FAILED, 'outcome': 'uncertain',
                      'sha256': state.digest(original), 'bytes': len(original)}
            state.upload(fake.release, receipt, json.dumps(failed).encode())
            path = Path(tmp) / 'state'
            with patch.object(state, 'request', side_effect=lambda method, path, *a, **kw:
                    {'private': True, 'visibility': 'private'} if path == '/repos/' + state.REPOSITORY else fake.request(method, path, *a, **kw)):
                recovery.prepare(path)
                self.assertEqual(path.read_bytes(), original)
                recovered = {'version': 4, 'lineage': 'same', 'serial': 2,
                             'outputs': {'bindings': {'value': {'verified_word_cache_namespace_id': recovery.NAMESPACE}}},
                             'resources': [{'type': 'cloudflare_workers_kv_namespace', 'name': 'verified_word_cache',
                                            'instances': [{'attributes': {'id': 'wrong'}}]}]}
                path.write_text(json.dumps(recovered))
                with self.assertRaises(state.StateError):
                    recovery.publish(path, '50000000000-1')
                recovered['resources'][0]['instances'][0]['attributes']['id'] = recovery.NAMESPACE
                path.write_text(json.dumps(recovered))
                recovery.publish(path, '50000000000-1')
                self.assertEqual(json.loads(next(x['payload'] for x in fake.items if x['name'] == receipt)), failed)
                with self.assertRaises(state.StateError):
                    recovery.prepare(path)


if __name__ == '__main__':
    unittest.main()

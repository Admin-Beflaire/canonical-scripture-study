"""GH-04 step 1: DP-04 storage boundaries over the Cloudflare REST API (loopback double)."""
import hashlib
import unittest
from unittest import mock

from css_preparation.executor.candidate import persist_candidate
from css_preparation.prepare.records import RecordError
from css_preparation.runner import cloudflare
from css_preparation.runner.cloudflare import CloudflareConfig, CloudflareStorage
from css_preparation.runner.web import Origin, ProviderError
from preparation_fixture import evidence_a
from runner_doubles import LoopbackApi


class CloudflareStorageTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.storage = CloudflareStorage(CloudflareConfig('acct', 'db', 'bucket', 'synthetic-token',
                                                          Origin(self.api.origin)))

    def test_candidate_unit_saved_in_one_batch_and_read_back(self):
        records = evidence_a()
        saved = persist_candidate(records, self.storage.candidate_store())
        self.assertEqual(saved.output_ids, tuple(records.output_ids()))
        self.assertEqual(self.api.batches, [len(records.statements())])
        for artifact in records.rows('artifact'):
            self.assertEqual(self.api.objects[artifact['registered_locator']], records.blobs[artifact['id']])
            self.assertEqual(self.storage.read_row('artifact', artifact['id']), artifact)
        # Every provider call carries the token only in its header.
        for _, path, headers in self.api.requests:
            self.assertEqual(headers['Authorization'], 'Bearer synthetic-token')
            self.assertNotIn('synthetic-token', path)
        # A retry of the same unit acknowledges the identical saved rows without a second write.
        persist_candidate(records, self.storage.candidate_store())
        self.assertEqual(len(self.api.batches), 1)

    def test_object_key_slashes_stay_literal_in_request_path(self):
        records = evidence_a()
        persist_candidate(records, self.storage.candidate_store())
        locator = records.rows('artifact')[0]['registered_locator']
        self.assertIn('/', locator)
        raw = [path for method, path, _ in self.api.requests if method == 'PUT']
        self.assertEqual(raw, [f'/client/v4/accounts/acct/r2/buckets/bucket/objects/{locator}'])
        self.assertNotIn('%2F', ''.join(path for _, path, _ in self.api.requests))
        self.storage.put_blob(f'prepared/{hashlib.sha256(b"x").hexdigest()}/a b#c?.txt', b'x')
        self.assertTrue(self.api.requests[-1][1].endswith('/a%20b%23c%3F.txt'))

    def test_paged_reads_return_every_row(self):
        records = evidence_a()
        persist_candidate(records, self.storage.candidate_store())
        expected = len(records.rows('native_span'))
        with mock.patch.object(cloudflare, '_PAGE_ROWS', 2):
            rows = self.storage.read_rows('native_span')
        self.assertEqual(len(rows), expected)
        self.assertEqual(len({row['id'] for row in rows}), expected)

    def test_failed_batch_leaves_nothing(self):
        records = evidence_a()
        statements = records.statements()
        broken = statements[:-1] + [(statements[-1][0], [None] * len(statements[-1][1]))]
        with self.assertRaises(ProviderError):
            self.storage.write_rows(broken)
        self.assertEqual(self.storage.read_rows('prepared_output'), [])

    def test_only_candidate_inserts_are_written(self):
        for sql in ('DELETE FROM artifacts', 'UPDATE release_selection SET release_id = ?',
                    'INSERT INTO release_selection (slot) VALUES (?)'):
            with self.assertRaises(ProviderError):
                self.storage.write_rows([(sql, ['x'])])
        with self.assertRaises(ProviderError):
            self.storage.write_rows([])

    def test_immutable_content_addressed_objects_and_missing_reads(self):
        one = hashlib.sha256(b'one').hexdigest()
        key = f'prepared/{one}/body.txt'
        self.storage.put_blob(key, b'one')
        self.storage.put_blob(key, b'one')
        self.assertEqual(self.storage.read_blob(key), b'one')
        # Different bytes can never target the same key: the key must carry their digest.
        with self.assertRaisesRegex(ProviderError, 'content digest'):
            self.storage.put_blob(key, b'two')
        with self.assertRaisesRegex(ProviderError, 'content digest'):
            self.storage.put_blob('prepared/x/a.bin', b'one')
        self.api.objects[key] = b'tampered'
        with self.assertRaisesRegex(ProviderError, 'different bytes'):
            self.storage.put_blob(key, b'one')
        with self.assertRaises(KeyError):
            self.storage.read_blob('prepared/x/missing.bin')
        for key in ('', '/abs', 'a/../b'):
            with self.assertRaises(ProviderError):
                self.storage.read_blob(key)

    def test_saved_bytes_differ_fails_closed(self):
        records = evidence_a()
        artifact = records.rows('artifact')[0]
        self.api.objects[artifact['registered_locator']] = b'tampered'
        with self.assertRaises(ProviderError):
            persist_candidate(records, self.storage.candidate_store())

    def test_private_records_and_registered_references(self):
        checkpoints = self.storage.record_store('checkpoints')
        reference = checkpoints.save(b'{"a":1}')
        self.assertEqual(reference['sha256'], hashlib.sha256(b'{"a":1}').hexdigest())
        self.assertEqual(checkpoints.load(reference), b'{"a":1}')
        self.assertTrue(self.storage.registered({'kind': 'artifact', 'id': reference['artifact_id'],
                                                 'sha256': reference['sha256'], 'byte_count': 7}))
        self.assertFalse(self.storage.registered({'kind': 'artifact', 'id': reference['artifact_id'],
                                                  'sha256': reference['sha256'], 'byte_count': 8}))
        records = evidence_a()
        persist_candidate(records, self.storage.candidate_store())
        artifact = records.rows('artifact')[0]
        source = next(r for r in records.rows('source_node') if r['kind'] == 'source_revision')
        self.assertTrue(self.storage.registered({'kind': 'artifact', 'id': artifact['id'],
                                                 'sha256': artifact['sha256'], 'byte_count': artifact['byte_count']}))
        self.assertTrue(self.storage.registered({'kind': 'source_revision', 'id': source['id']}))
        self.assertFalse(self.storage.registered({'kind': 'source_revision', 'id': 'synthetic:unknown'}))
        self.assertFalse(self.storage.registered({'kind': 'acquisition', 'id': 'synthetic:descriptor'}))

    def test_redirects_are_refused_and_token_not_forwarded(self):
        self.api.redirect_once = True
        with self.assertRaisesRegex(ProviderError, 'Redirect refused'):
            self.storage.read_row('artifact', 'synthetic:x')
        self.assertEqual(len(self.api.requests), 1)

    def test_wrong_token_and_invalid_configuration(self):
        bad = CloudflareStorage(CloudflareConfig('acct', 'db', 'bucket', 'wrong', Origin(self.api.origin)))
        with self.assertRaises(ProviderError) as caught:
            bad.read_row('artifact', 'synthetic:x')
        self.assertNotIn('wrong', str(caught.exception))
        for args in (('acct/x', 'db', 'bucket', 't'), ('acct', 'db', 'bucket', ''), ('acct', 'db', 'bucket', 'a b')):
            with self.assertRaises(ValueError):
                CloudflareConfig(*args)
        for origin in ('http://example.com', 'https://user:pw@example.com', 'https://example.com/'):
            with self.assertRaises(ValueError):
                Origin(origin)


if __name__ == '__main__':
    unittest.main()

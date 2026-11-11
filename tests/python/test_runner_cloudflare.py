"""GH-04 step 1: DP-04 storage boundaries over the Cloudflare REST API (loopback double)."""
import hashlib
import unittest
from unittest import mock

from css_preparation.executor.candidate import persist_candidate
from css_preparation.prepare.records import RecordError
from css_preparation.runner import cloudflare
from css_preparation.runner.cloudflare import CloudflareConfig, CloudflareStorage
from css_preparation.runner.web import Origin, ProviderError
from preparation_fixture import evidence_a, evidence_b
from runner_doubles import TOKEN_ID, LoopbackApi


def storage(api, token):
    return CloudflareStorage(CloudflareConfig('acct', 'db', 'bucket', token, TOKEN_ID, api=Origin(api.origin),
                                              r2_origin=Origin(api.origin)))


class CloudflareStorageTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.storage = storage(self.api, 'synthetic-token')

    def test_candidate_unit_saved_in_one_batch_and_read_back(self):
        records = evidence_a()
        saved = persist_candidate(records, self.storage.candidate_store())
        self.assertEqual(saved.output_ids, tuple(records.output_ids()))
        self.assertEqual(self.api.batches, [len(records.statements())])
        for artifact in records.rows('artifact'):
            self.assertEqual(self.api.objects[artifact['registered_locator']], records.blobs[artifact['id']])
            self.assertEqual(self.storage.read_row('artifact', artifact['id']), artifact)
        # D1 calls carry the token as a bearer header; R2 calls are SigV4-signed and never carry it.
        for _, path, headers in self.api.requests:
            self.assertNotIn('synthetic-token', path)
            if path.startswith('/bucket/'):
                self.assertTrue(headers['Authorization'].startswith(f'AWS4-HMAC-SHA256 Credential={TOKEN_ID}/'))
                self.assertNotIn('synthetic-token', headers['Authorization'])
            else:
                self.assertEqual(headers['Authorization'], 'Bearer synthetic-token')
        # A retry of the same unit acknowledges the identical saved rows without a second write.
        persist_candidate(records, self.storage.candidate_store())
        self.assertEqual(len(self.api.batches), 1)

    def test_r2_objects_use_the_s3_api_with_literal_key_slashes_and_atomic_create(self):
        records = evidence_a()
        persist_candidate(records, self.storage.candidate_store())
        locator = records.rows('artifact')[0]['registered_locator']
        self.assertIn('/', locator)
        puts = [(method, path, headers) for method, path, headers in self.api.requests if method == 'PUT']
        self.assertEqual([path for _, path, _ in puts], [f'/bucket/{locator}'])
        self.assertEqual({k.lower(): v for k, v in puts[0][2].items()}.get('if-none-match'), '*')
        self.assertNotIn('%2F', ''.join(path for _, path, _ in self.api.requests))
        self.storage.put_blob(f'prepared/{hashlib.sha256(b"x").hexdigest()}/a b#c?.txt', b'x')
        self.assertTrue(self.api.signed_paths[-1][1].endswith('/a%20b%23c%3F.txt'))
        self.assertNotIn('/client/v4/accounts/acct/r2/', ''.join(path for _, path, _ in self.api.requests))

    def test_paged_reads_return_every_row(self):
        records = evidence_a()
        persist_candidate(records, self.storage.candidate_store())
        expected = len(records.rows('native_span'))
        with mock.patch.object(cloudflare, '_PAGE_ROWS', 2):
            rows = self.storage.read_rows('native_span', records.output_ids())
        self.assertEqual(len(rows), expected)
        self.assertEqual(len({row['id'] for row in rows}), expected)

    def test_reads_are_scoped_to_the_named_outputs(self):
        first, second = evidence_a(), evidence_b()
        for records in (first, second):
            persist_candidate(records, self.storage.candidate_store())
        ids = first.output_ids()
        for kind in ('prepared_output', 'native_span', 'span_segment', 'annotation', 'coverage', 'artifact',
                     'text_payload', 'source_node'):
            with self.subTest(kind=kind):
                saved = self.storage.read_rows(kind, ids)
                self.assertEqual(sorted(map(str, saved)), sorted(map(str, first.rows(kind))))
        self.assertEqual(self.storage.read_rows('native_span', []), [])
        # Many output IDs are bound in chunks; rows reached twice come back once.
        with mock.patch.object(cloudflare, '_BOUND_IDS', 1):
            both = self.storage.read_rows('source_node', [*ids, *second.output_ids(), *ids])
        self.assertEqual(len(both), len(first.rows('source_node')) + len(second.rows('source_node')))
        for sql in self.api.queries:
            self.assertNotRegex(sql, r'FROM \w+ ORDER BY')  # never an unscoped table read

    def test_failed_batch_leaves_nothing(self):
        records = evidence_a()
        statements = records.statements()
        broken = statements[:-1] + [(statements[-1][0], [None] * len(statements[-1][1]))]
        with self.assertRaises(ProviderError):
            self.storage.write_rows(broken)
        self.assertEqual(self.storage.read_rows('prepared_output', records.output_ids()), [])

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
        bad = storage(self.api, 'wrong')
        with self.assertRaises(ProviderError) as caught:
            bad.read_row('artifact', 'synthetic:x')
        self.assertNotIn('wrong', str(caught.exception))
        # A wrong token also derives the wrong S3 secret: the signature is refused.
        with self.assertRaises(ProviderError) as caught:
            bad.read_blob('prepared/x/a.bin')
        self.assertEqual(caught.exception.status, 403)
        for args in (('acct/x', 'db', 'bucket', 't', TOKEN_ID), ('acct', 'db', 'bucket', '', TOKEN_ID),
                     ('acct', 'db', 'bucket', 'a b', TOKEN_ID), ('acct', 'db', 'bucket', 't', 'not-a-token-id')):
            with self.assertRaises(ValueError):
                CloudflareConfig(*args)
        for origin in ('http://example.com', 'https://user:pw@example.com', 'https://example.com/'):
            with self.assertRaises(ValueError):
                Origin(origin)


if __name__ == '__main__':
    unittest.main()

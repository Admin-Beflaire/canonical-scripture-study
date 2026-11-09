"""Exact-input records, admission blocking and storage routing (synthetic inputs)."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from css_preparation.acquire.retention import (AdmissionBasis, BlockedInput, InputRecord, assert_usable, notice_members,
                                               record_supplied, reusable, storage_route)

PROTECTED = AdmissionBasis(('owner-decision:1',), 'synthetic terms', True, 'not_allowed')
PUBLIC = AdmissionBasis(('owner-decision:2',), 'synthetic open licence', True, 'allowed')


class RetentionTest(unittest.TestCase):
    def supplied(self, admission=PROTECTED, coverage=('GEN',)):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'original.txt'
            path.write_bytes(b'In the beginning\n')
            return record_supplied(path, source_revision_id='src-rev-1', component='text', admission=admission, coverage=coverage)

    def test_supplied_original_keeps_exact_identity(self):
        record = self.supplied()
        self.assertEqual(record.sha256, hashlib.sha256(b'In the beginning\n').hexdigest())
        self.assertEqual((record.byte_count, record.complete, record.origin), (17, True, 'supplied'))

    def test_storage_route_follows_recorded_permissions(self):
        self.assertEqual(storage_route(self.supplied(), 'original.txt')[0], 'protected')
        self.assertTrue(storage_route(self.supplied(), 'original.txt')[1].startswith('originals/src-rev-1/'))
        self.assertEqual(storage_route(self.supplied(PUBLIC), 'original.txt'), ('public_git', 'sources/src-rev-1/original.txt'))
        unresolved = AdmissionBasis(('owner-decision:3',), 'terms', True, 'unresolved')
        self.assertEqual(storage_route(self.supplied(unresolved), 'original.txt')[0], 'protected')
        for name in ('../x.txt', 'dir/x.txt', '.hidden', ''):
            with self.assertRaises(BlockedInput):
                storage_route(self.supplied(), name)

    def test_unresolved_or_incomplete_input_is_blocked(self):
        for admission in (AdmissionBasis((), 'terms', True, 'allowed'), AdmissionBasis(('d',), '', True, 'allowed'),
                          AdmissionBasis(('d',), 'terms', None, 'allowed'), AdmissionBasis(('d',), 'terms', False, 'allowed')):
            with self.assertRaises(BlockedInput):
                assert_usable(self.supplied(admission))
        partial = InputRecord('src-rev-1', 'text', 'route-a', 'etag:"1"', 5, 'a' * 64, False, PROTECTED)
        with self.assertRaises(BlockedInput):
            storage_route(partial, 'x.txt')
        with self.assertRaises(BlockedInput):
            InputRecord('../src', 'text', 'route-a', 'etag', 5, 'a' * 64, True, PROTECTED)

    def test_reuse_needs_same_revision_and_coverage(self):
        record = self.supplied(coverage=('GEN', 'EXO'))
        self.assertIs(reusable([record], 'src-rev-1', ['GEN']), record)
        self.assertIsNone(reusable([record], 'src-rev-1', ['LEV']))
        self.assertIsNone(reusable([record], 'src-rev-2', ['GEN']))

    def test_notice_members(self):
        self.assertEqual(notice_members(['a/LICENSE.md', 'text.usfm', 'README', 'b/Copying.txt']),
                         ('README', 'a/LICENSE.md', 'b/Copying.txt'))


if __name__ == '__main__':
    unittest.main()

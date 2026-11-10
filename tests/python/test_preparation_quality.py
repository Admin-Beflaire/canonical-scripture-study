"""DP-04 Stage 5: semantic quality and immutable receipts using saved fixtures."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest

from css_preparation.contracts import contract_errors
from css_preparation.executor import ControlState
from css_preparation.executor.checkpoints import CheckpointStore
from css_preparation.executor.quality import check_candidate_quality
from css_preparation.prepare.records import RecordError
from preparation_fixture import COORDINATES, text_a
from test_saved_candidate_inventory import SavedInventoryStageFour

FIXTURE = json.loads((Path(__file__).resolve().parents[1] /
                      'conformance/maintenance-jobs.v1.json').read_text())


class CandidateQualityStageFive(unittest.TestCase):
    def setUp(self):
        self.saved = SavedInventoryStageFour('test_saved_evidence_and_index_validated_from_d1_and_r2')
        self.saved.setUp()
        self.addCleanup(self.saved.doCleanups)
        self.job = dict(FIXTURE['valid']['job_input'][0])
        self.job.update(kind='quality',
            input_refs=[{'kind': 'source_revision', 'id': 'synthetic:a:revision-1'}],
            native_extent={'unit_ids': [unit for unit, _ in text_a().units],
                           'coordinate_version': COORDINATES},
            required_capabilities=['source_context'],
            checkpoint_ref=None)
        self.received = {}
        self.receipts = CheckpointStore(self.save, self.load)
        self.raw = ''

    def save(self, data):
        key = hashlib.sha256(data).hexdigest()
        ref = {'artifact_id': 'quality:' + key[:32], 'sha256': key, 'byte_count': len(data)}
        self.received[ref['artifact_id']] = bytes(data)
        return ref

    def load(self, ref):
        return self.received[ref['artifact_id']]

    def invoke(self, *, job=None, rows=None, native=None, receipts=None, inventory=None,
               control=None, read_blob=None):
        job = dict(job or self.job)
        raw = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        state = ControlState(
            job['task_id'], job['task_revision'] + 1, 'running', job['basis_digest'],
            job['unit_id'], job['attempt'], job['task_revision'],
            hashlib.sha256(raw.encode()).hexdigest(), 'quality-5', 'dispatched')
        self.raw = raw
        self.state = state
        return check_candidate_quality(
            raw, run_id='quality-5', read_control=control or (lambda *_: state),
            registered=lambda _: True,
            inventory=inventory or self.saved.inventory,
            read_rows=rows or self.saved.rows,
            read_blob=read_blob or self.saved.blobs.__getitem__,
            read_source=native or (lambda _: text_a()),
            receipts=receipts or self.receipts)

    def test_valid_saved_candidate_receipt_repeats_exact_identity_and_actual_coverage(self):
        result = self.invoke()
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(contract_errors('job_result', result), [])
        self.assertEqual(result['completed_extent'], self.job['native_extent'])
        self.assertEqual(result['remaining_extent'], {})
        self.assertEqual(result['run_id'], 'quality-5')
        self.assertTrue(result['coverage_refs'])
        self.assertEqual(len(result['output_refs']), len(self.saved.records.rows('artifact')))
        doc = json.loads(self.load(result['quality_receipt_ref']))
        self.assertEqual(doc['contract_version'], 'preparation-quality/1')
        self.assertEqual(doc['candidate']['output_ids'],
                         [b.output_id for b in self.saved.inventory.added])
        self.assertEqual(doc['job_input_sha256'], hashlib.sha256(self.raw.encode()).hexdigest())
        self.assertEqual(doc['task']['input_refs'], self.job['input_refs'])
        self.assertEqual(doc['task']['recipe_revision'], self.job['recipe_revision'])
        self.assertEqual(doc['run_id'], result['run_id'])
        self.assertEqual(doc['coverage_refs'], result['coverage_refs'])
        self.assertEqual(doc['limitations'], [])
        self.saved.assert_no_selection_change()

    def test_empty_required_capabilities_cannot_claim_full_success(self):
        failed = self.invoke(job={**self.job, 'required_capabilities': []})
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(failed['completed_extent'], {})
        self.assertEqual(failed['remaining_extent'], self.job['native_extent'])
        self.assertIsNone(failed['quality_receipt_ref'])
        self.assertEqual(self.received, {})
        self.saved.assert_no_selection_change()

    def test_missing_native_source_does_not_issue_success_receipt(self):
        failed = self.invoke(native=lambda _: None)
        self.assertEqual(failed['state'], 'failed')
        self.assertIsNone(failed['quality_receipt_ref'])
        self.assertEqual(failed['completed_extent'], {})
        self.assertEqual(failed['remaining_extent'], self.job['native_extent'])
        self.assertEqual(self.received, {})

    def test_forged_saved_text_with_valid_digest_fails_source_fidelity(self):
        original = next(r for r in self.saved.rows('native_span') if r['content_id'] is not None)
        forged = 'forged wording'
        digest = hashlib.sha256(forged.encode('utf-8')).hexdigest()
        def read(kind):
            rows = self.saved.rows(kind)
            if kind == 'native_span':
                for row in rows:
                    if row['id'] == original['id']:
                        row['content_id'] = digest
            elif kind == 'text_payload':
                rows.append({'content_id': digest, 'exact_text': forged})
            return rows
        failed = self.invoke(rows=read)
        self.assertEqual(failed['state'], 'failed')
        self.assertIsNone(failed['quality_receipt_ref'])

    def test_changed_native_coordinates_and_missing_relationship_endpoint_fail(self):
        def wrong_nav(kind):
            rows = self.saved.rows(kind)
            if kind == 'span_segment':
                rows[0]['start_order'] += 1
            return rows
        self.assertEqual(self.invoke(rows=wrong_nav)['state'], 'failed')
        output_id = self.saved.inventory.added[0].output_id
        def dangling(kind):
            rows = self.saved.rows(kind)
            if kind == 'relationship':
                rows.append({'id': 'rel-x', 'output_id': output_id, 'kind': 'correspondence',
                             'direction': 'directed', 'status': 'supported', 'basis_json': {}})
            elif kind == 'relation_member':
                rows.append({'relationship_id': 'rel-x', 'role': 'source', 'ordinal': 0,
                             'span_id': 'nonexistent-span', 'correspondence': 'exact',
                             'gap_reason': None})
            return rows
        self.assertEqual(self.invoke(rows=dangling)['state'], 'failed')
        self.assertEqual(self.received, {})

    def test_required_capability_or_extent_gap_never_claims_success(self):
        missing = self.invoke(job={**self.job, 'required_capabilities': ['unavailable_method']})
        self.assertEqual(missing['state'], 'failed')
        self.assertEqual(missing['completed_extent'], {})
        word = self.invoke(job={**self.job, 'required_capabilities': ['word_exact']})
        self.assertEqual(word['state'], 'failed')
        unknown = self.invoke(job={**self.job, 'native_extent': {'unit_ids': ['not-covered']}})
        self.assertEqual(unknown['state'], 'failed')
        self.assertEqual(self.received, {})

    def test_changed_dependency_or_unverified_inventory_fails_without_receipt(self):
        changed = replace(self.saved.inventory.added[1], method_version='wrong-method')
        from css_preparation.validate.saved import CandidateInventory
        inventory = CandidateInventory(added=(self.saved.inventory.added[0], changed))
        failed = self.invoke(inventory=inventory)
        self.assertEqual(failed['state'], 'failed')
        def omitted(kind):
            rows = self.saved.rows(kind)
            if kind == 'coverage':
                return []
            return rows
        self.assertEqual(self.invoke(rows=omitted)['state'], 'failed')
        self.assertEqual(self.received, {})

    def test_corrupt_receipt_readback_returns_failure_and_no_reference(self):
        wrong = replace(self.receipts, load=lambda _: b'wrong')
        failed = self.invoke(receipts=wrong)
        self.assertEqual(failed['state'], 'failed')
        self.assertIsNone(failed['quality_receipt_ref'])
        self.saved.assert_no_selection_change()

    def test_receipt_is_identical_when_database_row_order_changes(self):
        first = self.invoke()
        self.assertEqual(first['state'], 'succeeded')
        second = self.invoke(rows=lambda kind: list(reversed(self.saved.rows(kind))))
        self.assertEqual(second['state'], 'succeeded')
        self.assertEqual(first['quality_receipt_ref'], second['quality_receipt_ref'])
        self.assertEqual(first['coverage_refs'], second['coverage_refs'])

    def test_cancelled_mid_quality_never_emits_receipt(self):
        from css_preparation.executor import UnitNotRunnable
        calls = [0]
        def reader(*_):
            calls[0] += 1
            return (self.state if calls[0] == 1 else
                    replace(self.state, task_state='cancelled', task_revision=3))
        with self.assertRaises(UnitNotRunnable):
            self.invoke(control=reader)
        self.assertEqual(calls[0], 2)
        self.assertEqual(self.received, {})

    def test_saved_object_changed_between_integrity_and_semantic_read_fails(self):
        row = self.saved.records.rows('artifact')[0]
        locator = row['registered_locator']
        read_count = [0]
        def changing(key):
            if key == locator:
                read_count[0] += 1
                if read_count[0] > 1:
                    return b'changed-after-validation'
            return self.saved.blobs[key]
        result = self.invoke(read_blob=changing)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['completed_extent'], {})
        self.assertIsNone(result['quality_receipt_ref'])
        self.assertEqual(self.received, {})

    def test_saved_artifact_disappears_between_reads_returns_failed_result(self):
        locator = self.saved.records.rows('artifact')[0]['registered_locator']
        for error_class in (KeyError, OSError):
            with self.subTest(error=error_class.__name__):
                calls = [0]
                def disappearing(key):
                    if key == locator:
                        calls[0] += 1
                        if calls[0] > 1:
                            raise error_class('synthetic storage disappearance')
                    return self.saved.blobs[key]
                result = self.invoke(read_blob=disappearing)
                self.assertEqual(result['state'], 'failed')
                self.assertEqual(result['diagnostics'][0]['code'], 'quality_failed')
                self.assertEqual(result['completed_extent'], {})
                self.assertEqual(result['remaining_extent'], self.job['native_extent'])
                self.assertIsNone(result['quality_receipt_ref'])
                self.assertGreaterEqual(calls[0], 2)
                self.assertEqual(self.received, {})
        self.saved.assert_no_selection_change()

    def test_changed_job_input_produces_distinct_immutable_receipt(self):
        first = self.invoke()
        self.assertEqual(first['state'], 'succeeded')
        changed = self.invoke(job={**self.job, 'recipe_revision': 'recipe-2'})
        self.assertEqual(changed['state'], 'succeeded')
        self.assertNotEqual(first['quality_receipt_ref'], changed['quality_receipt_ref'])
        for ref in (first['quality_receipt_ref'], changed['quality_receipt_ref']):
            data = self.load(ref)
            self.assertEqual(ref['byte_count'], len(data))
            self.assertEqual(ref['sha256'], hashlib.sha256(data).hexdigest())
        self.saved.assert_no_selection_change()


if __name__ == '__main__':
    unittest.main()

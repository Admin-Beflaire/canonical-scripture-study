"""DP-04 Stage 6: synthetic acquisition -> saved candidate -> checkpoint -> quality.

This is a contract-faithful Control/transport double, not live D1/R2 or a
deployed Workflow. Stage 6 never selects a release or admits a real source.
"""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from css_preparation.acquire.retention import AdmissionBasis, assert_usable, record_supplied
from css_preparation.contracts import contract_errors
from css_preparation.executor import ControlState, UnitNotRunnable, execute_unit
from css_preparation.executor.candidate import CandidateStore, persist_candidate
from css_preparation.executor.checkpoints import CheckpointStore, run_checkpointed_unit
from css_preparation.executor.quality import check_candidate_quality
from css_preparation.indexes.files import build_index_files
from css_preparation.indexes.source import build_source_postings
from css_preparation.prepare.evidence import OutputBasis
from css_preparation.prepare.records import RecordError, TABLES, decoded
from css_preparation.validate.saved import CandidateInventory
from preparation_fixture import COORDINATES, database, evidence_a, evidence_b, text_a
from test_source_index_builder import RULES, configured_basis

WIRE = json.loads((Path(__file__).resolve().parents[1] /
                   'conformance/dp04-control-wire.v1.json').read_text())
SOURCE_REV = 'synthetic:a:revision-1'


def basis_of(row):
    return OutputBasis(row['kind'], tuple(row['input_revisions_json']), row['method_version'],
                       row['parameters_json'], row['native_extent_json'],
                       tuple(row['validation_basis_json']['dependencies']))


class ControlDouble:
    """Only the existing dispatch identity and result-acceptance rules, no promotion."""

    def __init__(self):
        self.records = {}
        self.state = 'running'

    def accept(self, job, run_id, result):
        if contract_errors('job_result', result):
            return 'rejected', False
        if any(result[k] != job[k] for k in
               ('task_id', 'task_revision', 'unit_id', 'attempt', 'basis_digest')):
            return 'rejected', False
        if result['run_id'] != run_id:
            return 'rejected', False
        key = (job['task_id'], job['unit_id'], job['attempt'])
        data = json.dumps(result, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':')).encode('utf-8')
        identity = hashlib.sha256(data).hexdigest()
        prior = self.records.get(key)
        if prior and prior[0] == identity:
            return 'duplicate', prior[1] == 'succeeded' and self.state not in ('cancelled', 'superseded')
        if prior and prior[1] in ('succeeded', 'failed', 'cancelled'):
            return 'rejected', False
        state = 'cancelled' if self.state in ('cancelled', 'superseded') else result['state']
        self.records[key] = (identity, state)
        return 'accepted', state == 'succeeded'


class PreparationIntegratedStageSix(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.blobs = {}
        self.checkpoints = {}
        self.control = ControlDouble()
        self.source = text_a()
        self.evidence = evidence_a()
        self.evidence_basis = basis_of(self.evidence.rows('prepared_output')[0])
        parts = build_source_postings(
            self.source, self.evidence, configured_basis(self.evidence, self.source),
            RULES, max_units=2, max_scalars=64, max_occurrences=20)
        self.index = build_index_files(parts[0])
        self.index_basis = parts[0].basis
        self.store = CandidateStore(self.put, self.get, self.write, self.row, self.rows)
        self.ck = CheckpointStore(self.save_checkpoint, self.load_checkpoint)
        self.selection = tuple(tuple(r) for r in self.db.execute('SELECT * FROM release_selection'))

        # Real acquisition retention validation over synthetic bytes only.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic-source.txt'
            path.write_bytes(b'Synthetic source fixture, not copyrighted text.\n')
            self.original = record_supplied(
                path, source_revision_id=SOURCE_REV, component='text',
                admission=AdmissionBasis(('fixture:admitted',), 'synthetic fixture rights',
                                         True, 'not_allowed'),
                coverage=tuple(unit for unit, _ in self.source.units))
        assert_usable(self.original)
        self.assertEqual(self.original.source_revision_id, SOURCE_REV)
        self.assertEqual(self.original.sha256, hashlib.sha256(
            b'Synthetic source fixture, not copyrighted text.\n').hexdigest())

    def put(self, locator, data):
        if locator in self.blobs and self.blobs[locator] != data:
            raise RecordError('Immutable key collision')
        self.blobs[locator] = bytes(data)

    def get(self, locator):
        return self.blobs[locator]

    def write(self, statements):
        with self.db:
            for sql, values in statements:
                self.db.execute(sql, values)

    def rows(self, kind, *_):
        return decoded(self.db.execute('SELECT * FROM ' + TABLES[kind]).fetchall())

    def row(self, kind, identity):
        keys = {'prepared_output': ('id',), 'artifact': ('id',)}
        if kind not in keys:
            raise ValueError(kind)
        return next((r for r in self.rows(kind) if r['id'] == identity), None)

    def save_checkpoint(self, data):
        digest = hashlib.sha256(data).hexdigest()
        ref = {'artifact_id': 'checkpoint:' + digest[:32], 'sha256': digest,
               'byte_count': len(data)}
        current = self.checkpoints.setdefault(ref['artifact_id'], bytes(data))
        if current != data:
            raise RecordError('Conflicting immutable checkpoint')
        return ref

    def load_checkpoint(self, ref):
        return self.checkpoints[ref['artifact_id']]

    def registered(self, ref):
        if ref['kind'] == 'source_revision':
            return ref['id'] == self.original.source_revision_id
        if ref['kind'] != 'artifact':
            return False
        if ref['id'] in self.checkpoints:
            data = self.checkpoints[ref['id']]
            return (ref.get('sha256') == hashlib.sha256(data).hexdigest()
                    and ref.get('byte_count') == len(data))
        row = self.row('artifact', ref['id'])
        return bool(row and row['sha256'] == ref.get('sha256')
                    and row['byte_count'] == ref.get('byte_count'))

    def job(self, kind, unit_id, extent, *, deps=(), required=()):
        job = deepcopy(WIRE['job_input'])
        job.update(task_id='task-integration', unit_id=unit_id, kind=kind,
                   native_extent=dict(extent),
                   input_refs=[{'kind': 'source_revision', 'id': SOURCE_REV}],
                   dependency_refs=list(deps), required_capabilities=list(required),
                   checkpoint_ref=None)
        return job

    def raw_and_state(self, job, run_id):
        raw = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        state = ControlState(job['task_id'], job['task_revision'] + 1,
                             self.control.state, job['basis_digest'], job['unit_id'],
                             job['attempt'], job['task_revision'],
                             hashlib.sha256(raw.encode('utf-8')).hexdigest(),
                             run_id, 'dispatched')
        return raw, state

    def run_prepare(self, job, builder, *, run_id=None):
        run_id = run_id or 'run-' + job['unit_id']
        raw, state = self.raw_and_state(job, run_id)
        return run_checkpointed_unit(raw, run_id=run_id,
            read_control=lambda *_: state, registered=self.registered,
            acquire=lambda _: self.fail('unexpected acquisition handler'),
            prepare=builder,
            quality=lambda _: self.fail('unexpected quality handler'),
            storage=self.store, checkpoints=self.ck)

    def build(self):
        evidence_job = self.job('prepare', 'unit-evidence', self.evidence_basis.extent)
        first = self.run_prepare(evidence_job, lambda _: self.evidence)
        self.assertEqual(first.state, 'checkpointed')
        self.assertEqual(first.saved.output_ids, (self.evidence_basis.output_id,))
        self.assertTrue(first.saved.artifact_refs)
        indexed_job = self.job('prepare', 'unit-index', self.index_basis.extent,
                               deps=first.saved.artifact_refs)
        second = self.run_prepare(indexed_job, lambda _: self.index.records)
        self.assertEqual(second.state, 'checkpointed')
        self.assertEqual(second.saved.output_ids, (self.index_basis.output_id,))
        return evidence_job, indexed_job, first, second

    def quality(self, inventory=None, *, required=('source_context',), changed=None):
        job = self.job('quality', 'unit-quality',
                       {'unit_ids': [unit for unit, _ in self.source.units],
                        'coordinate_version': COORDINATES},
                       required=required)
        if changed:
            job.update(changed)
        run_id = 'run-unit-quality'
        raw, state = self.raw_and_state(job, run_id)
        result = check_candidate_quality(raw, run_id=run_id,
            read_control=lambda *_: state, registered=self.registered,
            inventory=inventory or CandidateInventory(added=(self.evidence_basis,),
                                                      reused=(self.index_basis,)),
            read_rows=self.rows, read_blob=self.get,
            read_source=lambda revision: self.source if revision == SOURCE_REV else None,
            receipts=self.ck)
        return job, run_id, result

    def assert_no_selection(self):
        self.assertEqual(tuple(tuple(r) for r in self.db.execute(
            'SELECT * FROM release_selection')), self.selection)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)

    def test_full_saved_evidence_index_restart_and_quality_result(self):
        _, index_job, _, second = self.build()
        saved = self.run_prepare({**index_job, 'checkpoint_ref': second.checkpoint_ref},
                                 lambda _: self.fail('verified index replay must not rebuild'))
        self.assertEqual(saved.saved, second.saved)
        inventory = CandidateInventory(added=(self.evidence_basis,),
                                       reused=(self.index_basis,))
        job, run_id, result = self.quality(inventory)
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(contract_errors('job_result', result), [])
        self.assertEqual(result['completed_extent'], job['native_extent'])
        self.assertEqual(result['remaining_extent'], {})
        receipt = json.loads(self.load_checkpoint(result['quality_receipt_ref']))
        self.assertEqual(receipt['candidate']['output_ids'],
                         [self.evidence_basis.output_id, self.index_basis.output_id])
        self.assertEqual(receipt['candidate']['reused'], [self.index_basis.row()])
        self.assertEqual(receipt['run_id'], run_id)
        self.assertEqual(self.control.accept(job, run_id, result), ('accepted', True))
        self.assertEqual(self.control.accept(job, run_id, result), ('duplicate', True))
        self.assert_no_selection()

    def test_changed_basis_omitted_dependents_and_incomplete_coverage(self):
        _, index_job, _, second = self.build()
        rebuilt = []
        changed = self.run_prepare({**index_job, 'recipe_revision': 'recipe-2',
                                    'checkpoint_ref': second.checkpoint_ref},
                                   lambda _: rebuilt.append(1) or self.index.records)
        self.assertEqual(changed.state, 'checkpointed')
        self.assertEqual(rebuilt, [1], 'new basis must not reuse old checkpoint')
        omitted = CandidateInventory(added=(self.index_basis,),
                                     omitted=(self.evidence_basis.output_id,))
        job, _, failed = self.quality(omitted)
        self.assertEqual(failed['state'], 'failed')
        self.assertIsNone(failed['quality_receipt_ref'])
        _, _, failed = self.quality(required=('word_exact',))
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(failed['completed_extent'], {})
        self.assert_no_selection()

    def test_omitted_old_candidate_keeps_reused_unrelated_outputs(self):
        self.build()
        unrelated = evidence_b()
        persist_candidate(unrelated, self.store)
        inventory = CandidateInventory(added=(self.evidence_basis,),
                                       reused=(self.index_basis,),
                                       omitted=tuple(unrelated.output_ids()))
        _, _, result = self.quality(inventory)
        self.assertEqual(result['state'], 'succeeded')
        receipt = json.loads(self.load_checkpoint(result['quality_receipt_ref']))
        self.assertEqual(receipt['candidate']['omitted'], unrelated.output_ids())
        self.assertEqual(set(receipt['candidate']['output_ids']),
                         {self.evidence_basis.output_id, self.index_basis.output_id})
        self.assertIn(unrelated.output_ids()[0], {r['id'] for r in self.rows('prepared_output')})
        self.assert_no_selection()

    def test_corrupt_saved_object_fails_quality_and_never_selects_release(self):
        _, _, first, _ = self.build()
        row = self.row('artifact', first.saved.artifact_refs[0]['artifact_id'])
        self.blobs[row['registered_locator']] = b'not the saved text'
        _, _, result = self.quality()
        self.assertEqual(result['state'], 'failed')
        self.assertIsNone(result['quality_receipt_ref'])
        self.assert_no_selection()

    def test_control_double_rejects_late_wrong_duplicate_and_changed_results(self):
        self.build()
        job, run, result = self.quality()
        for change in ({'run_id': 'wrong-run'}, {'basis_digest': 'f' * 64},
                       {'task_revision': 7}, {'unit_id': 'wrong-unit'}):
            self.assertEqual(self.control.accept(job, run, {**result, **change})[0],
                             'rejected')
        self.control.state = 'cancelled'
        self.assertEqual(self.control.accept(job, run, result), ('accepted', False))
        self.assertEqual(self.control.accept(job, run, result), ('duplicate', False))
        self.assert_no_selection()
        self.control = ControlDouble()
        self.control.state = 'superseded'
        self.assertEqual(self.control.accept(job, run, result), ('accepted', False))
        self.assert_no_selection()

    def test_exact_control_wire_bytes_and_json_reserialization_refusal(self):
        job, raw, expected = WIRE['job_input'], WIRE['canonical_json'], WIRE['sha256']
        self.assertEqual(hashlib.sha256(raw.encode('utf-8')).hexdigest(), expected)
        self.assertEqual(json.loads(raw), job)
        state = ControlState(job['task_id'], job['task_revision'] + 1, 'running',
                             job['basis_digest'], job['unit_id'], job['attempt'],
                             job['task_revision'], expected, 'run-wire', 'dispatched')
        reader = lambda *_: state
        registered = lambda ref: ref['kind'] == 'source_revision' and ref['id'] == SOURCE_REV
        self.assertEqual(execute_unit(raw, run_id='run-wire', read_control=reader,
                                      registered=registered, process=lambda _: 'ok'), 'ok')
        # Equivalent parsed data is NOT enough: Control has persisted the hash
        # of its own canonicalJson UTF-8 bytes. Transport cannot reserialize it.
        altered = json.dumps(job, ensure_ascii=False)
        self.assertNotEqual(altered, raw)
        with self.assertRaises(UnitNotRunnable):
            execute_unit(altered, run_id='run-wire', read_control=reader,
                         registered=registered, process=lambda _: self.fail('must not run'))


if __name__ == '__main__':
    unittest.main()

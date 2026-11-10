"""DP-04 Stage 2: synthetic candidate storage and one-unit module dispatch."""
from dataclasses import replace
import hashlib
import json
import tempfile
from pathlib import Path
import unittest

from css_preparation.acquire.retention import AdmissionBasis, record_supplied, assert_usable
from css_preparation.executor import ControlState, UnitNotRunnable
from css_preparation.executor.candidate import CandidateStore, persist_candidate, run_candidate_unit
from css_preparation.indexes.files import build_index_files
from css_preparation.indexes.source import build_source_postings
from css_preparation.prepare.records import RecordError, RecordSet, decoded

from preparation_fixture import database, evidence_a, text_a
from test_source_index_builder import RULES, configured_basis

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / 'conformance/maintenance-jobs.v1.json').read_text())


class CandidateStageTwo(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.blobs = {}
        self.puts = []
        self.saved_selection = list(self.db.execute('SELECT * FROM release_selection'))
        self.store = CandidateStore(self.put, self.read, self.write, self.find)

    def put(self, key, data):
        self.puts.append(key)
        if key in self.blobs and self.blobs[key] != data:
            raise RecordError('Immutable artifact key already has different bytes')
        self.blobs[key] = bytes(data)

    def read(self, key):
        return self.blobs[key]

    def write(self, statements):
        with self.db:
            for sql, params in statements:
                self.db.execute(sql, params)

    def find(self, kind, identity):
        table = {'prepared_output': 'prepared_outputs', 'artifact': 'artifacts'}[kind]
        rows = decoded(self.db.execute(f'SELECT * FROM {table} WHERE id = ?', (identity,)).fetchall())
        return rows[0] if rows else None

    def candidate(self):
        text = text_a()
        evidence = evidence_a()
        [part, *_] = build_source_postings(text, evidence, configured_basis(evidence, text), RULES,
                                           max_units=2, max_scalars=64, max_occurrences=20)
        return RecordSet().merge(evidence).merge(build_index_files(part).records)

    def run(self, kind, handler, *, state_change=None, storage=None):
        job = dict(FIXTURE['valid']['job_input'][0], kind=kind)
        raw = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        state = ControlState(job['task_id'], job['task_revision'] + 1, 'running', job['basis_digest'],
                             job['unit_id'], job['attempt'], job['task_revision'],
                             hashlib.sha256(raw.encode()).hexdigest(), 'run-9', 'dispatched')
        if state_change:
            state = replace(state, **state_change)
        handlers = {name: (handler if name == kind else lambda _: self.fail('Wrong module called'))
                    for name in ('acquire', 'prepare', 'quality')}
        return run_candidate_unit(raw, run_id='run-9', read_control=lambda *_: state,
                                  registered=lambda _: True, storage=storage or self.store, **handlers)

    def test_preparation_and_source_index_saved_with_exact_refs(self):
        saved = self.run('prepare', lambda _: self.candidate())
        self.assertEqual(len(saved.output_ids), 2)
        self.assertGreaterEqual(len(saved.artifact_refs), 2)
        self.assertEqual({r['artifact_id'] for r in saved.artifact_refs},
                         {row['id'] for row in decoded(self.db.execute('SELECT * FROM artifacts').fetchall())})
        for ref in saved.artifact_refs:
            metadata = self.find('artifact', ref['artifact_id'])
            data = self.blobs[metadata['registered_locator']]
            self.assertEqual((ref['sha256'], ref['byte_count']),
                             (hashlib.sha256(data).hexdigest(), len(data)))
        self.assertEqual(set(saved.output_ids), {r['id'] for r in
            decoded(self.db.execute('SELECT * FROM prepared_outputs').fetchall())})
        self.assertEqual(list(self.db.execute('SELECT * FROM release_selection')), self.saved_selection)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM release_outputs').fetchone()[0], 0)

    def test_acquisition_and_quality_use_separate_existing_modules_without_claiming_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'synthetic.txt'
            path.write_bytes(b'Synthetic source bytes')
            called = []
            def acquisition(_):
                source = record_supplied(path, source_revision_id='synthetic:revision-1', component='text',
                    admission=AdmissionBasis(('owner:synthetic',), 'synthetic eligible', True, 'not_allowed'))
                assert_usable(source)
                called.append(('acquire', source.sha256))
                # Retention of originals is owned by the acquisition module.
                return RecordSet()
            result = self.run('acquire', acquisition)
            self.assertEqual(result.output_ids, ())
            self.assertEqual(result.artifact_refs, ())
            self.assertEqual(called[0][0], 'acquire')
        def quality(_):
            called.append(('quality', 'synthetic'))
            # Saved-inventory checking and receipts are Stage 4/5, not a Stage 2 success claim.
            return RecordSet()
        result = self.run('quality', quality)
        self.assertEqual((result.output_ids, result.artifact_refs), ((), ()))
        self.assertEqual(called[-1][0], 'quality')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)

    def test_invalid_outputs_or_storage_failures_cannot_report_refs(self):
        records = self.candidate()
        artifact = records.rows('artifact')[0]
        self.blobs[artifact['registered_locator']] = b'preexisting different bytes'
        with self.assertRaises(RecordError):
            self.run('prepare', lambda _: records)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        self.blobs.clear()
        corrupt = replace(self.store, read_blob=lambda _: b'corrupt')
        with self.assertRaisesRegex(RecordError, 'differ'):
            self.run('prepare', lambda _: records, storage=corrupt)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        def failed_write(_):
            raise RuntimeError('synthetic D1 unavailable')
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            self.run('prepare', lambda _: records, storage=replace(self.store, write_rows=failed_write))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        with self.assertRaisesRegex(RecordError, 'identity differs'):
            self.run('prepare', lambda _: records, storage=replace(self.store, read_row=lambda *_: None))
        self.assertEqual(list(self.db.execute('SELECT * FROM release_selection')), self.saved_selection)

    def test_missing_artifact_metadata_bytes_and_invalid_module_result(self):
        records = self.candidate()
        records.blobs.pop(next(iter(records.blobs)))
        with self.assertRaisesRegex(RecordError, 'bytes and metadata'):
            self.run('prepare', lambda _: records)
        self.assertEqual(self.puts, [])
        with self.assertRaisesRegex(RecordError, 'RecordSet'):
            self.run('prepare', lambda _: 'not records')
        self.assertEqual(self.puts, [])

    def test_gated_out_runs_do_not_write_or_invoke_handler(self):
        with self.assertRaises(UnitNotRunnable):
            self.run('prepare', lambda _: self.fail('Processing should not begin'),
                     state_change={'task_state': 'paused'})
        self.assertEqual(self.puts, [])


if __name__ == '__main__':
    unittest.main()

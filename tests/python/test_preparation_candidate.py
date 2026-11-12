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

    def invoke(self, kind, handler, *, state_change=None, storage=None):
        job = dict(FIXTURE['valid']['job_input'][0], kind=kind)
        if kind == 'prepare':
            from preparation_fixture import COORDINATES
            job['input_refs'] = [{'kind': 'source_revision',
                                  'id': 'synthetic:a:revision-1'}]
            job['native_extent'] = {'unit_ids': [u for u, _ in text_a().units],
                                    'coordinate_version': COORDINATES}
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
        saved = self.invoke('prepare', lambda _: self.candidate())
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
            result = self.invoke('acquire', acquisition)
            self.assertEqual(result.output_ids, ())
            self.assertEqual(result.artifact_refs, ())
            self.assertEqual(called[0][0], 'acquire')
        def quality(_):
            called.append(('quality', 'synthetic'))
            # Saved-inventory checking and receipts are Stage 4/5, not a Stage 2 success claim.
            return RecordSet()
        result = self.invoke('quality', quality)
        self.assertEqual((result.output_ids, result.artifact_refs), ((), ()))
        self.assertEqual(called[-1][0], 'quality')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)

    def test_invalid_outputs_or_storage_failures_cannot_report_refs(self):
        records = self.candidate()
        artifact = records.rows('artifact')[0]
        self.blobs[artifact['registered_locator']] = b'preexisting different bytes'
        with self.assertRaises(RecordError):
            self.invoke('prepare', lambda _: records)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        self.blobs.clear()
        corrupt = replace(self.store, read_blob=lambda _: b'corrupt')
        with self.assertRaisesRegex(RecordError, 'differ'):
            self.invoke('prepare', lambda _: records, storage=corrupt)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        def failed_write(_):
            raise RuntimeError('synthetic D1 unavailable')
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            self.invoke('prepare', lambda _: records, storage=replace(self.store, write_rows=failed_write))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 0)
        with self.assertRaisesRegex(RecordError, 'identity differs'):
            self.invoke('prepare', lambda _: records, storage=replace(self.store, read_row=lambda *_: None))
        self.assertEqual(list(self.db.execute('SELECT * FROM release_selection')), self.saved_selection)

    def test_rebuild_reuses_identical_saved_output_and_adds_new_ones(self):
        # An earlier build saved the evidence; a rebuild with the same evidence basis adds a new index.
        first = self.invoke('prepare', lambda _: evidence_a())
        evidence_id = first.output_ids[0]
        spans = self.db.execute('SELECT COUNT(*) FROM native_spans').fetchone()[0]
        saved = self.invoke('prepare', lambda _: self.candidate())
        self.assertEqual(len(saved.output_ids), 2)
        self.assertIn(evidence_id, saved.output_ids)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM native_spans').fetchone()[0], spans)
        index_id = next(i for i in saved.output_ids if i != evidence_id)
        self.assertGreater(self.db.execute('SELECT COUNT(*) FROM artifacts WHERE output_id = ?',
                                           (index_id,)).fetchone()[0], 0)
        self.assertGreater(self.db.execute('SELECT COUNT(*) FROM coverage WHERE output_id = ?',
                                           (index_id,)).fetchone()[0], 0)
        # Repeating the whole candidate is acknowledged again without writing.
        writes = []
        counting = replace(self.store, write_rows=lambda st: (writes.append(st), self.write(st)))
        self.assertEqual(self.invoke('prepare', lambda _: self.candidate(), storage=counting), saved)
        self.assertEqual(writes, [])
        self.assertEqual(list(self.db.execute('SELECT * FROM release_selection')), self.saved_selection)

    def test_saved_output_that_differs_or_lacks_artifacts_is_refused(self):
        records = self.candidate()
        [index] = [row for row in records.rows('prepared_output') if row['kind'] == 'source_search']
        # The output row is saved but its artifacts are not: incomplete.
        self.write([(sql, params) for sql, params in records.statements()
                    if sql.startswith('INSERT INTO prepared_outputs') and index['id'] in params])
        with self.assertRaisesRegex(RecordError, 'incomplete or different'):
            self.invoke('prepare', lambda _: records)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM prepared_outputs').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM artifacts').fetchone()[0], 0)
        # A saved output whose recorded row differs is refused, never overwritten.
        def differing(kind, identity):
            row = self.find(kind, identity)
            return dict(row, method_version='other/1') if row and kind == 'prepared_output' else row
        with self.assertRaisesRegex(RecordError, 'incomplete or different'):
            self.invoke('prepare', lambda _: records, storage=replace(self.store, read_row=differing))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM native_spans').fetchone()[0], 0)

    def test_without_outputs_drops_only_owned_rows_and_bytes(self):
        records = self.candidate()
        evidence_id = evidence_a().output_ids()[0]
        rest = records.without_outputs([evidence_id])
        self.assertNotIn(evidence_id, rest.output_ids())
        for kind in ('native_span', 'annotation', 'relationship', 'coverage', 'artifact'):
            self.assertFalse([r for r in rest.rows(kind) if r['output_id'] == evidence_id], kind)
        self.assertEqual(rest.rows('span_segment'), [])
        self.assertEqual(rest.rows('source_node'), records.rows('source_node'))
        self.assertEqual(set(rest.blobs), {r['id'] for r in rest.rows('artifact')})
        self.assertEqual(len(records.output_ids()), 2)  # the original is unchanged

    def test_missing_artifact_metadata_bytes_and_invalid_module_result(self):
        records = self.candidate()
        records.blobs.pop(next(iter(records.blobs)))
        with self.assertRaisesRegex(RecordError, 'bytes and metadata'):
            self.invoke('prepare', lambda _: records)
        self.assertEqual(self.puts, [])
        with self.assertRaisesRegex(RecordError, 'RecordSet'):
            self.invoke('prepare', lambda _: 'not records')
        self.assertEqual(self.puts, [])

    def test_missing_d1_identity_is_none_for_keyerror_adapter(self):
        empty = replace(self.store, read_row=lambda *_: (_ for _ in ()).throw(KeyError('missing')))
        self.assertIsNone(empty.optional_row('prepared_output', 'absent'))
        self.assertIsNone(self.store.optional_row('prepared_output', 'absent'))
        self.assertIsNone(self.store.optional_row('artifact', 'absent'))

    def test_external_dependency_uses_saved_output_identity_not_artifact_id(self):
        from css_preparation.executor.basis import (
            check_output_basis, registered_dependency_outputs,
        )
        output = evidence_a().rows('prepared_output')[0]
        output['validation_basis_json'] = {
            **output['validation_basis_json'], 'dependencies': ['upstream:output']}
        job = dict(FIXTURE['valid']['job_input'][0], kind='prepare',
            input_refs=[{'kind': 'source_revision', 'id': 'synthetic:a:revision-1'}],
            native_extent={'unit_ids': [unit for unit, _ in text_a().units]})
        job['dependency_refs'] = [{'artifact_id': 'upstream:artifact',
                                   'sha256': 'a' * 64, 'byte_count': 12}]
        candidate = replace(self.store, read_row=lambda kind, identity:
            {'id': identity, 'output_id': 'upstream:output',
             'sha256': 'a' * 64, 'byte_count': 12} if kind == 'artifact' else None)
        resolved = registered_dependency_outputs(job, candidate)
        self.assertEqual(resolved, {'upstream:output'})
        check_output_basis(job, [output], resolved)
        with self.assertRaisesRegex(RecordError, 'undeclared'):
            check_output_basis(job, [output], set())

    def test_gated_out_runs_do_not_write_or_invoke_handler(self):
        with self.assertRaises(UnitNotRunnable):
            self.invoke('prepare', lambda _: self.fail('Processing should not begin'),
                     state_change={'task_state': 'paused'})
        self.assertEqual(self.puts, [])


if __name__ == '__main__':
    unittest.main()

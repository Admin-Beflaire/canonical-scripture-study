"""DP-04 Stage 4: saved D1/R2 candidate inventory checks with synthetic fixtures."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import unittest

from css_preparation.indexes.files import build_index_files, _object_key
from css_preparation.indexes.source import build_source_postings
from css_preparation.prepare.records import RecordError, RecordSet, TABLES, decoded
from css_preparation.validate.saved import CandidateInventory, verify_candidate_inventory

from preparation_fixture import database, evidence_a, evidence_b, save, text_a
from test_source_index_builder import RULES, configured_basis


class SavedInventoryStageFour(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        evidence = evidence_a()
        text = text_a()
        parts = build_source_postings(
            text, evidence, configured_basis(evidence, text), RULES,
            max_units=2, max_scalars=64, max_occurrences=20)
        self.index = build_index_files(parts[0])
        self.bases = (next(iter(evidence.rows('prepared_output'))), parts[0].basis)
        self.evidence_basis = evidence.rows('prepared_output')[0]
        self.records = RecordSet().merge(evidence).merge(self.index.records)
        save(self.records, self.db)
        self.blobs = {row['registered_locator']: self.records.blobs[row['id']]
                      for row in self.records.rows('artifact')}
        self.inventory = CandidateInventory(
            added=(self._evidence_basis(), parts[0].basis))
        self.selected_before = [tuple(row) for row in self.db.execute(
            'SELECT * FROM release_selection')]

    def _evidence_basis(self):
        from css_preparation.prepare.evidence import OutputBasis
        row = self.evidence_basis
        return OutputBasis(row['kind'], tuple(row['input_revisions_json']),
                           row['method_version'], row['parameters_json'],
                           row['native_extent_json'],
                           tuple(row['validation_basis_json']['dependencies']))

    def rows(self, kind, *_):
        return decoded(self.db.execute('SELECT * FROM ' + TABLES[kind]).fetchall())

    def check(self, *, inventory=None, read_rows=None, read_blob=None, limit=2048):
        return verify_candidate_inventory(
            self.inventory if inventory is None else inventory,
            read_rows=read_rows or self.rows,
            read_blob=read_blob or self.blobs.__getitem__,
            max_page_bytes=limit)

    def assert_no_selection_change(self):
        self.assertEqual([tuple(row) for row in self.db.execute(
            'SELECT * FROM release_selection')], self.selected_before)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)

    def test_saved_evidence_and_index_validated_from_d1_and_r2(self):
        got = self.check()
        self.assertEqual(got.output_ids, tuple(b.output_id for b in self.inventory.added))
        self.assertEqual(got.index_ids, (self.index.manifest['prepared_output_id'],))
        self.assertEqual({r['artifact_id'] for r in got.artifact_refs},
                         {r['id'] for r in self.records.rows('artifact')})
        self.assert_no_selection_change()

    def test_reused_output_is_checked_and_omission_does_not_delete_rows(self):
        unrelated = evidence_b()
        save(unrelated, self.db)
        for row in unrelated.rows('artifact'):
            self.blobs[row['registered_locator']] = unrelated.blobs[row['id']]
        inventory = CandidateInventory(
            added=(self.inventory.added[0],),
            reused=(self.inventory.added[1],),
            omitted=tuple(unrelated.output_ids()))
        got = self.check(inventory=inventory)
        self.assertEqual(got.output_ids, tuple(b.output_id for b in self.inventory.added))
        self.assertTrue(self.rows('prepared_output')[-1]['id'] in unrelated.output_ids())
        self.assert_no_selection_change()

    def test_invalid_basis_input_returns_record_error(self):
        with self.assertRaisesRegex(RecordError, 'exact output bases'):
            self.check(inventory=CandidateInventory(added=(object(),)))
        self.assert_no_selection_change()

    def test_omitted_dependency_and_incompatible_reused_output_fail(self):
        evidence_basis, index_basis = self.inventory.added
        with self.assertRaisesRegex(RecordError, 'missing or omitted dependency'):
            self.check(inventory=CandidateInventory(
                added=(), reused=(index_basis,), omitted=(evidence_basis.output_id,)))
        with self.assertRaisesRegex(RecordError, 'contradictory membership'):
            self.check(inventory=CandidateInventory(
                added=(evidence_basis,), omitted=(evidence_basis.output_id,)))
        changed = replace(index_basis, method_version='synthetic:other')
        with self.assertRaisesRegex(RecordError, 'Missing saved candidate output'):
            self.check(inventory=CandidateInventory(
                added=(evidence_basis,), reused=(changed,)))
        self.assert_no_selection_change()

    def test_missing_required_saved_d1_rows_are_rejected(self):
        kinds = ('prepared_output', 'source_node', 'coverage', 'text_payload', 'span_segment', 'artifact')
        for kind in kinds:
            with self.subTest(kind=kind):
                full = self.rows(kind)
                if kind == 'prepared_output':
                    absent = next(r for r in full if r['id'] == self.index.manifest['prepared_output_id'])
                elif kind == 'source_node':
                    absent = next(r for r in full if r['kind'] == 'source_revision')
                elif kind == 'coverage':
                    absent = next(r for r in full if r['output_id'] == self.index.manifest['prepared_output_id'])
                elif kind == 'artifact':
                    absent = next(r for r in full if r['id'] == self.index.manifest_artifact_id)
                else:
                    absent = full[0]
                def missing(which, _ids=(), kind=kind, absent=absent):
                    got = self.rows(which)
                    return [r for r in got if r != absent] if which == kind else got
                with self.assertRaises(RecordError):
                    self.check(read_rows=missing)
        self.assert_no_selection_change()

    def test_corrupt_or_missing_r2_bytes_fail_for_all_saved_outputs(self):
        for row in self.records.rows('artifact'):
            with self.subTest(artifact=row['id']):
                corrupt = dict(self.blobs)
                corrupt[row['registered_locator']] = b'bad'
                with self.assertRaisesRegex(RecordError, 'Corrupt or incomplete'):
                    self.check(read_blob=corrupt.__getitem__)
                missing = dict(self.blobs)
                del missing[row['registered_locator']]
                with self.assertRaisesRegex(RecordError, 'Missing saved R2'):
                    self.check(read_blob=missing.__getitem__)
        self.assert_no_selection_change()

    def test_saved_schema_and_coverage_basis_are_checked(self):
        def bad_span(kind, *_):
            rows = self.rows(kind)
            if kind == 'native_span':
                rows[0]['coordinate_version'] = None
            return rows
        with self.assertRaisesRegex(RecordError, 'Invalid saved native_span'):
            self.check(read_rows=bad_span)

        def bad_dependency(kind, *_):
            rows = self.rows(kind)
            if kind == 'coverage':
                for row in rows:
                    if row['output_id'] == self.index.manifest['prepared_output_id']:
                        row['dependencies_json'] = []
            return rows
        with self.assertRaisesRegex(RecordError, 'incompatible'):
            self.check(read_rows=bad_dependency)
        self.assert_no_selection_change()

    def _forge_manifest(self, mutate):
        original = self.index.manifest_artifact_id
        artifact = next(r for r in self.rows('artifact') if r['id'] == original)
        manifest = json.loads(self.blobs[artifact['registered_locator']])
        mutate(manifest)
        data = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':')).encode('utf-8')
        digest = hashlib.sha256(data).hexdigest()
        replacement = original.split(':manifest:')[0] + ':manifest:' + digest[:20]
        new_locator = _object_key(artifact['output_id'], digest, 'manifest.json')
        def rows(kind, *_):
            result = self.rows(kind)
            if kind == 'artifact':
                for row in result:
                    if row['id'] == original:
                        row.update(id=replacement, sha256=digest, byte_count=len(data),
                                   registered_locator=new_locator)
            elif kind == 'coverage':
                for row in result:
                    if row['index_artifact_id'] == original:
                        row['index_artifact_id'] = replacement
            return result
        def blob(locator):
            return data if locator == new_locator else self.blobs[locator]
        return rows, blob

    def test_forged_saved_manifest_page_boundaries_and_limits_fail(self):
        with self.assertRaisesRegex(RecordError, 'page cap'):
            self.check(limit=700)
        for mutate in (
            lambda m: m['files'][0]['pages'][0].update(first_key='wrong'),
            lambda m: m['files'][0]['pages'][0].update(byte_length=2049),
            lambda m: m['files'][0]['pages'][0].update(byte_offset=1),
        ):
            with self.subTest(mutation=mutate.__code__.co_firstlineno):
                rows, blob = self._forge_manifest(mutate)
                with self.assertRaises(RecordError):
                    self.check(read_rows=rows, read_blob=blob)
        self.assert_no_selection_change()


if __name__ == '__main__':
    unittest.main()

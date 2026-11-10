"""DP-03 Stage 4: saved-index integrity, dependency-scoped reuse and invalidation."""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import unittest

from css_preparation.indexes.files import build_index_files, _object_key
from css_preparation.indexes.saved import verify_saved_index, reusable_index_ids
from css_preparation.prepare.records import RecordError, RecordSet
from test_word_index_builder import WordIndexStageTwo


class SavedIndexStageFour(unittest.TestCase):
    def setUp(self):
        fixture = WordIndexStageTwo()
        fixture.setUp()
        self.source_part = fixture.parts[0]
        self.a = build_index_files(self.source_part)
        self.b = build_index_files(fixture.parts[1])
        self.word = build_index_files(fixture.build()[0])
        self.external = tuple(fixture.evidence.output_ids())
        self.records = RecordSet()
        for built in (self.a, self.b, self.word):
            self.records.merge(built.records)
        self.outputs = self.records.rows('prepared_output')
        self.artifacts = self.records.rows('artifact')
        self.coverage = self.records.rows('coverage')
        self.blobs = dict(self.records.blobs)
        self.bases = (fixture.parts[0].basis, fixture.parts[1].basis, fixture.build()[0].basis)

    def check(self, built, *, saved_output=None, artifacts=None, coverage=None, blobs=None,
              max_page_bytes=2048):
        output = saved_output if saved_output is not None else next(
            row for row in self.outputs if row['id'] == built.manifest['prepared_output_id'])
        return verify_saved_index(
            next(basis for basis in self.bases if basis.output_id == built.manifest['prepared_output_id']),
            output,
            self.artifacts if artifacts is None else artifacts,
            self.coverage if coverage is None else coverage,
            self.blobs if blobs is None else blobs,
            max_page_bytes=max_page_bytes)

    def mutate_manifest(self, built, mutate):
        """Forge consistent registry SHA/size so a structural defect is reached."""
        manifest = deepcopy(built.manifest)
        mutate(manifest)
        content = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':')).encode('utf-8')
        digest = hashlib.sha256(content).hexdigest()
        old_id = built.manifest_artifact_id
        new_id = f"{built.manifest['prepared_output_id']}:manifest:{digest[:20]}"
        artifacts = deepcopy(self.artifacts)
        for row in artifacts:
            if row['id'] == old_id:
                row.update(id=new_id, sha256=digest, byte_count=len(content),
                           registered_locator=_object_key(row['output_id'], digest, 'manifest.json'))
        coverage = deepcopy(self.coverage)
        for row in coverage:
            if row['index_artifact_id'] == old_id:
                row['index_artifact_id'] = new_id
        blobs = dict(self.blobs)
        del blobs[old_id]
        blobs[new_id] = content
        return artifacts, coverage, blobs

    def test_valid_source_and_word_saved_files_reuse_in_dependency_order(self):
        for built in (self.a, self.b, self.word):
            self.assertEqual(self.check(built), built.manifest)
        chosen = reusable_index_ids((self.bases[2], self.bases[1], self.bases[0]),
                                    self.outputs, self.artifacts, self.coverage,
                                    self.blobs, valid_external_dependencies=self.external)
        self.assertEqual(chosen, (self.bases[2].output_id, self.bases[1].output_id,
                                  self.bases[0].output_id))
        self.assertEqual(self.records.rows('artifact'), self.artifacts)

    def test_reordered_dependencies_keep_same_immutable_coverage_and_reuse(self):
        # OutputBasis IDs already ignore dependency tuple order. Saved coverage must too.
        fixture = WordIndexStageTwo()
        fixture.setUp()
        [word_part] = fixture.build()
        reversed_basis = replace(
            word_part.basis, dependencies=tuple(reversed(word_part.basis.dependencies)))
        self.assertGreater(len(word_part.basis.dependencies), 1)
        self.assertNotEqual(word_part.basis.dependencies, reversed_basis.dependencies)
        self.assertEqual(word_part.basis.output_id, reversed_basis.output_id)

        original = build_index_files(word_part)
        reordered = build_index_files(replace(word_part, basis=reversed_basis))
        self.assertEqual(original.records.rows('prepared_output'),
                         reordered.records.rows('prepared_output'))
        self.assertEqual(original.records.rows('coverage'), reordered.records.rows('coverage'))
        self.assertEqual(original.records.blobs, reordered.records.blobs)
        self.assertEqual(
            verify_saved_index(reversed_basis,
                               next(row for row in self.outputs
                                    if row['id'] == reversed_basis.output_id),
                               self.artifacts, self.coverage, self.blobs),
            self.word.manifest)
        self.assertEqual(
            reusable_index_ids((self.bases[0], self.bases[1], reversed_basis),
                               self.outputs, self.artifacts, self.coverage, self.blobs,
                               valid_external_dependencies=self.external),
            tuple(basis.output_id for basis in self.bases))

    def test_portable_object_keys_and_wrong_cap_rejected(self):
        built = self.a
        for artifact in built.records.rows('artifact'):
            self.assertNotIn(':', artifact['registered_locator'])
            self.assertNotIn('\\', artifact['registered_locator'])
            self.assertTrue(artifact['registered_locator'].startswith('prepared/source_search/'))
        wrong = replace(self.bases[0], parameters={**self.bases[0].parameters,
                                                    'encoded_page_cap_bytes': 700})
        self.assertNotEqual(wrong.output_id, self.bases[0].output_id)
        with self.assertRaisesRegex(RecordError, 'reuse basis'):
            verify_saved_index(wrong, self.a.records.rows('prepared_output')[0],
                               self.a.records.rows('artifact'),
                               self.a.records.rows('coverage'), self.a.records.blobs)

    def test_wrong_basis_or_missing_registered_bytes_are_not_reused(self):
        saved = next(row for row in self.outputs if row['id'] == self.a.manifest['prepared_output_id'])
        wrong = {**saved, 'method_version': 'changed'}
        with self.assertRaisesRegex(RecordError, 'reuse basis'):
            self.check(self.a, saved_output=wrong)
        for lost in (self.a.postings_artifact_id, self.a.manifest_artifact_id):
            blobs = {key: value for key, value in self.blobs.items() if key != lost}
            with self.subTest(lost=lost), self.assertRaisesRegex(RecordError, 'incomplete saved artifact'):
                self.check(self.a, blobs=blobs)
        replaced = {**self.blobs, self.a.postings_artifact_id: b'corrupted'}
        with self.assertRaisesRegex(RecordError, 'artifact'):
            self.check(self.a, blobs=replaced)
        self.assertEqual(reusable_index_ids((self.bases[0],), self.outputs, self.artifacts,
                         self.coverage, replaced, valid_external_dependencies=self.external), ())

    def test_page_caps_and_manifest_directory_fail_closed(self):
        with self.assertRaisesRegex(RecordError, 'page cap'):
            self.check(self.a, max_page_bytes=1024)
        for change in (
            lambda m: m['files'][0]['pages'][0].update(byte_offset=1),
            lambda m: m['files'][0]['pages'][0].update(first_key='wrong'),
            lambda m: m['files'][0]['pages'][0].update(byte_length=2049),
            lambda m: m['files'][0]['pages'].pop(),
        ):
            with self.subTest(change=change.__code__.co_firstlineno):
                artifacts, coverage, blobs = self.mutate_manifest(self.a, change)
                with self.assertRaises(RecordError):
                    self.check(self.a, artifacts=artifacts, coverage=coverage, blobs=blobs)

    def test_complete_coverage_required_and_registry_consistency(self):
        artifacts, covered, blobs = self.mutate_manifest(
            self.a, lambda m: m['coverage'].update(state='partial', limitation='Missing unit'))
        for row in covered:
            if row['output_id'] == self.a.manifest['prepared_output_id']:
                row.update(state='partial', limitation='Missing unit')
        with self.assertRaisesRegex(RecordError, 'Incomplete saved index coverage'):
            self.check(self.a, artifacts=artifacts, coverage=covered, blobs=blobs)
        altered = deepcopy(self.coverage)
        for row in altered:
            if row['output_id'] == self.word.manifest['prepared_output_id']:
                row['index_artifact_id'] = self.a.manifest_artifact_id
        with self.assertRaises(RecordError):
            self.check(self.word, coverage=altered)
        altered = deepcopy(self.artifacts)
        altered.append(dict(altered[0]))
        with self.assertRaisesRegex(RecordError, 'Duplicate saved artifact'):
            self.check(self.a, artifacts=altered)

    def test_reject_misordered_rows_even_with_recomputed_digests(self):
        # One page, with every digest/registry/key range forged consistently.
        from css_preparation.indexes.files import build_index_files
        source_part = replace(self.source_part, basis=replace(
            self.source_part.basis, parameters={**self.source_part.basis.parameters,
                                                'encoded_page_cap_bytes': 10000}))
        built = build_index_files(source_part, encoded_page_cap_bytes=10000)
        original = built.records.blobs[built.postings_artifact_id]
        lines = original.splitlines(keepends=True)
        self.assertGreater(len(lines), 2)
        shuffled = b''.join(reversed(lines))
        manifest = deepcopy(built.manifest)
        [file] = manifest['files']
        [page] = file['pages']
        body_sha = hashlib.sha256(shuffled).hexdigest()
        old_posting = built.postings_artifact_id
        new_posting = f"{source_part.basis.output_id}:postings:{body_sha[:20]}"
        file.update(artifact_id=new_posting, sha256=body_sha)
        page.update(sha256=body_sha, first_key=json.loads(lines[-1])['search_key'],
                    last_key=json.loads(lines[0])['search_key'])
        payload = json.dumps(manifest, sort_keys=True, ensure_ascii=False,
                             separators=(',', ':')).encode('utf-8')
        manifest_sha = hashlib.sha256(payload).hexdigest()
        old_manifest = built.manifest_artifact_id
        new_manifest = f"{source_part.basis.output_id}:manifest:{manifest_sha[:20]}"
        artifacts = deepcopy(built.records.rows('artifact'))
        for item in artifacts:
            if item['id'] == old_posting:
                item.update(id=new_posting, sha256=body_sha,
                            registered_locator=_object_key(source_part.basis.output_id, body_sha, 'postings.ndjson'))
            if item['id'] == old_manifest:
                item.update(id=new_manifest, sha256=manifest_sha,
                            byte_count=len(payload),
                            registered_locator=_object_key(source_part.basis.output_id, manifest_sha, 'manifest.json'))
        coverage = deepcopy(built.records.rows('coverage'))
        for item in coverage:
            item['index_artifact_id'] = new_manifest
        blobs = {new_posting: shuffled, new_manifest: payload}
        with self.assertRaisesRegex(RecordError, 'bytewise order'):
            verify_saved_index(source_part.basis, built.records.rows('prepared_output')[0],
                               artifacts, coverage, blobs, max_page_bytes=10000)

    def test_correction_and_removal_omit_dependents_keep_unrelated(self):
        # Part B is independent of part A; word depends on part A.
        old_a, unaffected, word = self.bases
        changed_a = replace(old_a, parameters={**old_a.parameters, 'recipe_revision': 'corrected'})
        for desired in ((changed_a, unaffected, word), (unaffected, word)):
            chosen = reusable_index_ids(desired, self.outputs, self.artifacts, self.coverage,
                                        self.blobs, valid_external_dependencies=self.external)
            self.assertEqual(chosen, (unaffected.output_id,))
        # Deleting the evidence dependency invalidates both native source outputs.
        chosen = reusable_index_ids(self.bases, self.outputs, self.artifacts, self.coverage,
                                    self.blobs, valid_external_dependencies=())
        self.assertEqual(chosen, ())
        with self.assertRaisesRegex(RecordError, 'External dependencies'):
            reusable_index_ids((old_a,), self.outputs, self.artifacts, self.coverage, self.blobs,
                               valid_external_dependencies=(old_a.output_id,))


if __name__ == '__main__':
    unittest.main()

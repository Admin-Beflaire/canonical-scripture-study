"""DP-03 Stage 3: immutable index files, page boundaries and registry."""
from dataclasses import replace
import hashlib
import json
import unittest

from css_preparation.indexes.files import build_index_files
from css_preparation.indexes.source import build_source_postings
from css_preparation.prepare.records import RecordError
from css_preparation.validation import SchemaSubset
from preparation_fixture import evidence_a, text_a
from test_source_index_builder import RULES, configured_basis

_MANIFEST = SchemaSubset('indexes/manifest.v2.schema.json')


def with_cap(part, cap):
    return replace(part, basis=replace(part.basis, parameters={**part.basis.parameters, 'encoded_page_cap_bytes': cap}))


def common_rows(part, count):
    """`count` synthetic occurrences of one key at one native order: one key spanning many pages."""
    sample = next(row for row in part.postings if row['search_key'])
    return tuple({**sample, 'occurrence_id': f'synthetic-{i:03d}'} for i in range(count))


def read_directory(result):
    """Decode the directory pages listed by the manifest root, checking digests and boundaries."""
    root = result.manifest['directory']
    body = result.records.blobs[root['artifact_id']]
    entries, cursor = [], 0
    for page in root['pages']:
        data = body[cursor:cursor + page['byte_length']]
        assert page['byte_offset'] == cursor and data.endswith(b'\n')
        assert page['sha256'] == hashlib.sha256(data).hexdigest()
        rows = [json.loads(line) for line in data.splitlines()]
        assert (page['first_key'], page['last_key']) == (rows[0]['first_key'], rows[-1]['last_key'])
        entries.extend(rows)
        cursor += len(data)
    assert cursor == len(body) == root['byte_length']
    return entries


class IndexFilesStageThree(unittest.TestCase):
    def setUp(self):
        self.text = text_a()
        self.evidence = evidence_a()
        self.parts = build_source_postings(self.text, self.evidence,
                                           configured_basis(self.evidence, self.text), RULES,
                                           max_units=2, max_scalars=64, max_occurrences=20)

    def test_exact_page_offsets_digests_and_registered_coverage(self):
        base = self.parts[0]
        part = with_cap(replace(base, postings=tuple(sorted(
            base.postings + common_rows(base, 12),
            key=lambda r: (r['search_key'].encode(), r['native_order'], r['occurrence_id'].encode())))), 2048)
        result = build_index_files(part, encoded_page_cap_bytes=2048)
        self.assertEqual(_MANIFEST.document_errors(result.manifest), [])
        records = result.records
        self.assertEqual(records.output_ids(), [part.basis.output_id])
        body = records.blobs[result.postings_artifact_id]
        meta = result.manifest['files'][0]
        self.assertEqual(meta['byte_length'], len(body))
        self.assertEqual(meta['sha256'], hashlib.sha256(body).hexdigest())
        self.assertEqual(json.loads(records.blobs[result.manifest_artifact_id]), result.manifest)
        self.assertEqual(result.manifest['format_version'], 'index-manifest/2')
        self.assertEqual(result.manifest['native_extent'], {'unit_ids': part.basis.extent['unit_ids'],
                                                            'order_range': list(part.order_range)})
        self.assertEqual(result.manifest['coverage']['capabilities'], ['word_exact'])
        self.assertLessEqual(len(records.blobs[result.manifest_artifact_id]), 2048)
        entries = read_directory(result)
        self.assertEqual({e['postings_artifact_id'] for e in entries}, {result.postings_artifact_id})
        self.assertGreater(len(entries), 1)
        cursor, decoded = 0, []
        for page in entries:
            self.assertEqual(page['byte_offset'], cursor)
            self.assertLessEqual(page['byte_length'], 2048)
            data = body[cursor:cursor + page['byte_length']]
            self.assertEqual(len(data), page['byte_length'])
            self.assertTrue(data.endswith(b'\n'))
            self.assertEqual(page['sha256'], hashlib.sha256(data).hexdigest())
            rows = [json.loads(line) for line in data.splitlines()]
            self.assertEqual((page['first_key'], page['last_key']),
                             (rows[0]['search_key'], rows[-1]['search_key']))
            decoded.extend(rows)
            cursor += len(data)
        self.assertEqual(cursor, len(body))
        self.assertEqual(decoded, list(part.postings))
        artifacts = {item['id']: item for item in records.rows('artifact')}
        self.assertEqual(set(artifacts), {result.postings_artifact_id, result.manifest_artifact_id,
                                          result.directory_artifact_id})
        self.assertEqual(artifacts[result.directory_artifact_id]['format'], 'application/x-ndjson; profile=index-directory')
        for artifact_id, artifact in artifacts.items():
            self.assertTrue(artifact['registered_locator'].startswith('prepared/'))
            self.assertNotIn('://', artifact['registered_locator'])
            self.assertEqual(artifact['byte_count'], len(records.blobs[artifact_id]))
            self.assertEqual(artifact['sha256'], hashlib.sha256(records.blobs[artifact_id]).hexdigest())
        [coverage] = records.rows('coverage')
        self.assertEqual(coverage['index_artifact_id'], result.manifest_artifact_id)
        self.assertEqual(coverage['native_extent_json'], result.manifest['native_extent'])
        again = build_index_files(part, encoded_page_cap_bytes=2048)
        self.assertEqual(result.manifest, again.manifest)
        self.assertEqual(records.blobs, again.records.blobs)

    def test_common_utf8_key_spans_postings_and_directory_pages_without_lost_rows(self):
        base = self.parts[0]
        rows = common_rows(base, 80)
        sample = rows[0]
        part = with_cap(replace(base, postings=rows), 2048)
        result = build_index_files(part, encoded_page_cap_bytes=2048)
        pages = read_directory(result)
        self.assertGreater(len(pages), 5)
        self.assertGreater(len(result.manifest['directory']['pages']), 1, 'the key also spans directory pages')
        self.assertEqual({p['first_key'] for p in pages}, {sample['search_key']})
        self.assertEqual({p['last_key'] for p in pages}, {sample['search_key']})
        body = result.records.blobs[result.postings_artifact_id]
        decoded = [json.loads(line) for line in body.splitlines()]
        self.assertEqual([row['occurrence_id'] for row in decoded],
                         [row['occurrence_id'] for row in rows])

    def test_page_cap_changes_immutable_output_and_coverage_identity(self):
        normal = self.parts[0]
        compact = with_cap(normal, 2048)
        a = build_index_files(normal)
        b = build_index_files(compact, encoded_page_cap_bytes=2048)
        self.assertNotEqual(normal.basis.output_id, compact.basis.output_id)
        self.assertNotEqual(a.manifest['prepared_output_id'], b.manifest['prepared_output_id'])
        self.assertNotEqual(a.manifest_artifact_id, b.manifest_artifact_id)
        self.assertNotEqual(a.postings_artifact_id, b.postings_artifact_id)
        self.assertEqual(a.records.blobs[a.postings_artifact_id],
                         b.records.blobs[b.postings_artifact_id])
        self.assertNotEqual(a.records.rows('coverage')[0]['output_id'],
                            b.records.rows('coverage')[0]['output_id'])

    def test_manifest_schema_rejects_duplicate_coverage_capabilities(self):
        built = build_index_files(self.parts[0])
        invalid = {**built.manifest, 'coverage': {
            **built.manifest['coverage'], 'capabilities': ['word_exact', 'word_exact']}}
        self.assertTrue(_MANIFEST.document_errors(invalid))

    def test_reject_unrepresentable_lines_invalid_order_and_identity(self):
        base = self.parts[0]
        sample = base.postings[0]
        with self.assertRaisesRegex(RecordError, 'exceeds encoded page cap'):
            small = replace(base, postings=(sample,), basis=replace(
                base.basis, parameters={**base.basis.parameters, 'encoded_page_cap_bytes': 8}))
            build_index_files(small, encoded_page_cap_bytes=8)
        with self.assertRaisesRegex(RecordError, 'cap differs from immutable'):
            build_index_files(base, encoded_page_cap_bytes=700)
        with self.assertRaisesRegex(RecordError, 'bytewise'):
            build_index_files(replace(base, postings=tuple(reversed(base.postings))))
        with self.assertRaisesRegex(RecordError, 'Duplicate'):
            build_index_files(replace(base, postings=(sample, sample)))
        with self.assertRaisesRegex(RecordError, 'identity'):
            build_index_files(replace(base, postings=({**sample, 'source_revision_id': 'foreign'},)))
        with self.assertRaisesRegex(RecordError, 'no postings'):
            build_index_files(replace(base, postings=()))
        with self.assertRaisesRegex(RecordError, 'positive safe'):
            build_index_files(base, encoded_page_cap_bytes=True)
        with self.assertRaisesRegex(RecordError, 'manifest exceeds the page cap'):
            build_index_files(with_cap(replace(base, postings=(sample,)), 900), encoded_page_cap_bytes=900)
        with self.assertRaisesRegex(RecordError, 'order range'):
            build_index_files(replace(base, order_range=None))
        with self.assertRaisesRegex(RecordError, 'identity or native extent'):
            build_index_files(replace(base, order_range=(sample['native_order'] + 1, sample['native_order'] + 2)))

    def test_word_provider_alternatives_and_partial_manifest_coverage(self):
        from test_word_index_builder import WordIndexStageTwo
        fixture = WordIndexStageTwo()
        fixture.setUp()
        [word] = fixture.build()
        result = build_index_files(word)
        self.assertEqual(result.manifest['analysis_revision_ids'],
                         ['synthetic:analysis-a', 'synthetic:analysis-b'])
        self.assertEqual(set(result.manifest['coverage']['capabilities']),
                         {'form_exact', 'lemma_exact', 'grammar_exact'})
        rows = [json.loads(line) for line in
                result.records.blobs[result.postings_artifact_id].splitlines()]
        self.assertTrue(all({a['provider'] for a in row['analyses']} ==
                            {'provider-A', 'provider-B'} for row in rows))
        partial = build_index_files(replace(word, coverage_state='partial',
                                           limitation='Synthetic: incomplete analysis'))
        self.assertEqual(partial.manifest['coverage']['state'], 'partial')
        self.assertEqual({r['state'] for r in partial.records.rows('coverage')}, {'partial'})
        self.assertEqual({r['index_artifact_id'] for r in partial.records.rows('coverage')},
                         {partial.manifest_artifact_id})
        invalid = {**word.postings[0], 'analyses': [{**word.postings[0]['analyses'][0],
                                                   'analysis_revision_id': 'foreign'}]}
        with self.assertRaisesRegex(RecordError, 'Unrecorded analysis'):
            build_index_files(replace(word, postings=(invalid,)))


if __name__ == '__main__':
    unittest.main()

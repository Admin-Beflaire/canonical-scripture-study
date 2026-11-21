import hashlib
import json
import unittest

from css_preparation.adapters.step_aids import AidRecipe
from css_preparation.prepare.evidence import SourceIdentity, SourceLevel
from css_preparation.prepare.records import RecordError
from test_stepbible_lexicon import HEBREW
from test_oshb_bdb import BDB, INDEX
from test_stepbible_lsj import EXTRA

STEP = '5de0a47f35f0fc13dfe1430d104e5db8a4285f9c'
BDB_COMMIT = '21c9add13bc727d3a951361778e97e3ff7afd1ce'


class Store:
    def __init__(self, inputs):
        self.nodes, self.blobs = {}, {}
        for rev, data in inputs.items():
            key = 'synthetic/' + rev
            identity = SourceIdentity(
                SourceLevel(rev + ':work', 'work'), SourceLevel(rev + ':edition', 'edition'),
                SourceLevel(rev + ':representation', 'representation'),
                SourceLevel(rev, 'revision', {'sha256': hashlib.sha256(data).hexdigest(),
                                               'byte_count': len(data), 'locator': key}),
                'synthetic attribution', 'https://example.test')
            self.nodes.update({row['id']: row for row in identity.rows()})
            self.blobs[key] = data

    def read_row(self, kind, key):
        return self.nodes.get(key) if kind == 'source_node' else None

    def read_blob(self, key):
        return self.blobs[key]


def recipe(component, commit, revision):
    coord = 'language-aids/' + component + '/1'
    unit = {'unit_id': 'prepare-000', 'kind': 'prepare',
            'native_extent': {'unit_ids': ['p000'], 'coordinate_version': coord}, 'depends_on': []}
    cap = 'grammar_expansion' if component in ('tehmc', 'tegmc') else 'lexicon_entry'
    raw = {'native_extent': {'coordinate_version': coord}, 'units': [unit]}
    return AidRecipe(raw, component, commit, revision, cap, 1), unit


class PreparationTest(unittest.TestCase):
    def test_hebrew_preserves_restriction_and_private_body(self):
        rev = 'fixture-tbesh/1'
        store = Store({rev: HEBREW.encode()})
        recipe_, unit = recipe('tbesh', STEP, rev)
        records = recipe_.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'], 'native_extent': unit['native_extent'],
                                   'input_refs': [{'kind': 'source_revision', 'id': rev}]}, store)
        self.assertGreater(len(records.rows('annotation')), 1)
        self.assertEqual(records.rows('text_payload'), [])
        self.assertTrue(records.blobs)
        for row in records.rows('annotation'):
            self.assertEqual(row['details_json']['body_field'], 'gloss')
            self.assertNotIn('definition', row['details_json'])
        self.assertEqual(records.rows('coverage')[0]['capability'], 'lexicon_entry')
        self.assertEqual(recipe_.read_source(rev, store).unit('p000').encode(),
                         next(iter(records.blobs.values())))

    def test_bdb_and_index_keep_separate_source_revisions(self):
        for component, data, rev, work in (
                ('bdb', BDB, 'fixture-bdb/1', 'oshb-bdb'),
                ('bdb-index', INDEX, 'fixture-index/1', 'oshb-lexical-index')):
            with self.subTest(component=component):
                store = Store({rev: data.encode()})
                reader, unit = recipe(component, BDB_COMMIT, rev)
                refs = [{'kind': 'source_revision', 'id': rev}]
                records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                          'native_extent': unit['native_extent'], 'input_refs': refs}, store)
                self.assertEqual(records.rows('prepared_output')[0]['input_revisions_json'], [rev])
                self.assertTrue(all(row['details_json']['work_id'] == work
                                    for row in records.rows('annotation')))
                self.assertTrue(all('work in progress' in row['details_json']['source_limitation']
                                    for row in records.rows('annotation')))

    def test_saved_candidate_quality_checks_bdb_output(self):
        from css_preparation.prepare.evidence import OutputBasis
        from css_preparation.validate.saved import CandidateInventory
        from css_preparation.validate.semantic import check_saved_semantics
        rev = 'fixture-bdb/1'
        store = Store({rev: BDB.encode()})
        reader, unit = recipe('bdb', BDB_COMMIT, rev)
        refs = [{'kind': 'source_revision', 'id': rev}]
        records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                  'native_extent': unit['native_extent'], 'input_refs': refs}, store)
        basis = OutputBasis('evidence', (rev,), 'language-aids/1',
                            {'component': 'bdb', 'commit': BDB_COMMIT, 'body_storage': 'r2'},
                            {'coordinate_version': 'language-aids/bdb/1', 'unit_ids': ['p000']})
        blobs = {row['registered_locator']: records.blobs[row['id']] for row in records.rows('artifact')}
        result = check_saved_semantics(
            {'input_refs': refs, 'native_extent': {'unit_ids': ['p000']},
             'required_capabilities': ['lexicon_entry']},
            CandidateInventory(added=(basis,)), read_rows=lambda kind, _: records.rows(kind),
            read_blob=blobs.__getitem__, read_source=lambda revision: reader.read_source(revision, store))
        self.assertIn('lexicon_entry', result.capabilities)

    def test_empty_lsj_meaning_is_a_gap_without_substituting_gloss(self):
        rev = 'fixture-lsj/1'
        store = Store({rev: EXTRA.encode()})
        reader, unit = recipe('tflsj-extra', STEP, rev)
        records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                  'native_extent': unit['native_extent'],
                                  'input_refs': [{'kind': 'source_revision', 'id': rev}]}, store)
        spans = records.rows('native_span')
        notes = records.rows('annotation')
        self.assertEqual(spans[-1]['reading_kind'], 'gap')
        self.assertEqual(notes[-1]['details_json']['gloss'], 'Sin')

    def test_all_recipe_partitions_fit_the_runner_batch_at_observed_sizes(self):
        from pathlib import Path
        from unittest.mock import patch
        from css_preparation.adapters.language_aid_entries import AidEntry
        from css_preparation.runner.cloudflare import _BATCH_STATEMENTS

        root = Path(__file__).resolve().parents[2]
        counts = {'tbesh': 11682, 'tbesg': 11035, 'tflsj-0-5624': 5709,
                  'tflsj-extra': 5325, 'tehmc': 1013, 'tegmc': 1732,
                  'bdb': 11845, 'bdb-index': 10221}
        for name, count in counts.items():
            with self.subTest(component=name):
                raw = json.loads((root / 'collection/recipes' / f'language-aids-{name}.json').read_text())
                reader = AidRecipe.from_recipe(raw)
                # Non-empty bodies give the maximum row count; actual gaps can only reduce it.
                entries = [AidEntry(f'e{i}', 'synthetic-work', 'synthetic-edition', 'text', {})
                           for i in range(count)]
                store = Store({reader.revision: b'synthetic original'})
                method = ('bdb_entries' if name == 'bdb' else
                          'bdb_index_entries' if name == 'bdb-index' else 'step_entries')
                with patch('css_preparation.adapters.step_aids.' + method, return_value=entries):
                    units = [unit for unit in raw['units'] if unit['kind'] == 'prepare']
                    self.assertEqual(len(units), reader.partitions)
                    for unit in units:
                        records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                                  'native_extent': unit['native_extent'],
                                                  'input_refs': [{'kind': 'source_revision',
                                                                  'id': reader.revision}]}, store)
                        self.assertLess(len(records.statements()), _BATCH_STATEMENTS,
                                             f"{name} {unit['unit_id']}")

    def test_independent_partition_jobs_reuse_verified_r2_cache(self):
        from unittest.mock import patch
        from css_preparation.adapters.language_aid_entries import step_entries

        rev = 'fixture-tbesh/1'
        store = Store({rev: HEBREW.encode()})
        store.partitions = {}
        store.read_partition_cache = lambda key: store.partitions.get(key)
        store.write_partition_cache = lambda key, data: store.partitions.setdefault(key, data)
        coord = 'language-aids/tbesh/1'
        units = [{'unit_id': f'prepare-{i:03d}', 'kind': 'prepare',
                  'native_extent': {'unit_ids': [f'p{i:03d}'], 'coordinate_version': coord},
                  'depends_on': []} for i in range(2)]
        reader = AidRecipe({'native_extent': {'coordinate_version': coord}, 'units': units},
                           'tbesh', STEP, rev, 'lexicon_entry', 2)
        def run(unit):
            return reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                   'native_extent': unit['native_extent'],
                                   'input_refs': [{'kind': 'source_revision', 'id': rev}]}, store)
        with patch('css_preparation.adapters.step_aids.step_entries', wraps=step_entries) as parsed:
            first = run(units[0])
            assert parsed.call_count == 1  # One original read/parse for all partitions.
            second = run(units[1])
            self.assertEqual(parsed.call_count, 1, 'later job must not reparse the full source')
            self.assertEqual(len(store.partitions), 2)
            self.assertNotEqual(first.rows('prepared_output')[0]['id'],
                                second.rows('prepared_output')[0]['id'])
            # Quality reads the pinned original directly, independent of cached partitions.
            self.assertEqual(len(reader.read_source(rev, store).units), 2)
            self.assertEqual(parsed.call_count, 2)
            # Changing the registered digest invalidates the cache rather than using stale bytes.
            store.nodes[rev]['details_json']['sha256'] = 'f' * 64
            with self.assertRaises(RecordError):
                run(units[1])

    def test_original_digest_is_checked(self):
        rev = 'fixture-tbesh/1'
        store = Store({rev: HEBREW.encode()})
        store.blobs['synthetic/' + rev] = b'changed'
        recipe_, unit = recipe('tbesh', STEP, rev)
        with self.assertRaises(RecordError):
            recipe_.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'], 'native_extent': unit['native_extent'],
                             'input_refs': [{'kind': 'source_revision', 'id': rev}]}, store)


if __name__ == '__main__':
    unittest.main()

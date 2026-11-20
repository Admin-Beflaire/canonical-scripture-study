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

    def test_reviewed_bdb_partition_fits_the_runner_batch(self):
        from pathlib import Path
        root = Path(__file__).resolve().parents[2]
        ns = 'http://openscriptures.github.com/morphhb/namespace'
        for name, count in (('bdb', 11845), ('bdb-index', 10221)):
            with self.subTest(component=name):
                raw = json.loads((root / 'collection/recipes' / f'language-aids-{name}.json').read_text())
                reader = AidRecipe.from_recipe(raw)
                entries = ''.join(f'<entry id="e{i}"><w>word</w></entry>' for i in range(count))
                if name == 'bdb':
                    text = f'<lexicon xmlns="{ns}"><part id="a"><section id="s">{entries}</section></part></lexicon>'
                else:
                    text = f'<index xmlns="{ns}"><part>{entries}</part></index>'
                store = Store({reader.revision: text.encode()})
                unit = raw['units'][0]
                records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'],
                                          'native_extent': unit['native_extent'],
                                          'input_refs': [{'kind': 'source_revision', 'id': reader.revision}]}, store)
                self.assertLessEqual(len(records.statements()), 1000)

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

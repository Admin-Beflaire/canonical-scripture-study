import json
import unittest
from css_preparation.adapters.language_aid_entries import bdb_entries, step_entries
import test_stepbible_lexicon as testlex
import test_stepbible_lsj as testlsj
import test_stepbible_morphology as testmorph
import test_oshb_bdb as testbdb


class IntegrationEntriesTest(unittest.TestCase):
    def test_hebrew_restriction_and_homonyms(self):
        entries = step_entries('tbesh', testlex.HEBREW.encode(), commit=testlex.COMMIT)
        self.assertGreater(len(entries), 1)
        self.assertTrue(all(json.loads(e.body)['definition'] is None for e in entries))
        self.assertEqual(len({e.entry_id for e in entries}), len(entries))

    def test_lsj_empty_definition_is_not_replaced(self):
        entries = step_entries('tflsj-extra', testlsj.EXTRA.encode(), commit=testlsj.COMMIT)
        self.assertEqual(json.loads(entries[-1].body)['meaning'], '')
        self.assertEqual(entries[-1].work, 'TFLSJ')

    def test_grammar_explanations_are_not_dropped(self):
        entries = step_entries('tegmc', testmorph.GREEK.encode(), commit=testlsj.COMMIT)
        expected = sum(map(len, __import__('css_preparation.adapters.stepbible.morphology',
            fromlist=['read_morphology']).read_morphology(testmorph.GREEK, 'greek').values()))
        self.assertEqual(len(entries), expected)
        self.assertEqual(len({e.entry_id for e in entries}), len(entries))

    def test_bdb_and_all_index_entries_are_retained(self):
        entries = bdb_entries(testbdb.BDB.encode(), testbdb.INDEX.encode(), commit=testbdb.COMMIT)
        articles = [e for e in entries if e.work == 'oshb-bdb']
        index = [e for e in entries if e.work == 'oshb-lexical-index']
        self.assertEqual((len(articles), len(index)), (2, 2))
        self.assertEqual(articles[0].lookup['index_links'][0]['strong'], '1')
        self.assertEqual(articles[1].lookup['index_links'][0]['index_entry_id'], index[0].entry_id)
        self.assertIn('references', json.loads(index[-1].body))

if __name__ == '__main__':
    unittest.main()

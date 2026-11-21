import json
import unittest
from pathlib import Path

from css_preparation.adapters.stepbible.tipnr import read_tipnr
from css_preparation.adapters.step_aids import AidRecipe
from test_language_aid_preparation import Store, STEP

SYNTHETIC = '''$========== PERSON(s)
Alex@Mat.1.1=G1234G\tFirst person\tParent@Mat.1.1(?)
– Named\tAlex@Mat.1.1\tG1234G«G1234=α\tAlex\tMat.1.1a; Mat.1.2
– Greek\tAlex@Mat.1.1\tG4321«G4321=β\tAlexander\tAct.1.1
– Total\tAlex\tAlex\tG1234G\tMat.1.1ff
@Ambiguity=https://example.test/ambiguity
$========== PERSON(s)
Alex@Mat.2.1=G1234H\tSecond person
– Named\tAlex@Mat.2.1\tG1234H«G1234=α\tAlex\tMat.2.1
$========== PLACE
Alex@Act.2.1=G1234I\tPlace
– Named\tAlex@Act.2.1\tG1234I«G1234=α\tAlex\tAct.2.1
$========== OTHER
Other@Act.1.1=G0001\tOther
– Named\tOther@Act.1.1\tG0001«G0001=α\tOther\tAct.1.1
'''.encode()

class TipnrTest(unittest.TestCase):
    def test_separate_people_places_forms_and_uncertainty(self):
        entries = read_tipnr(SYNTHETIC, commit=STEP)
        self.assertEqual(len(entries), 4)
        self.assertEqual([e.lookup['disambiguated_strong'] for e in entries], ['G1234G', 'G4321', 'G1234H', 'G1234I'])
        self.assertEqual(entries[0].lookup['identity'], entries[1].lookup['identity'])
        self.assertNotEqual(entries[0].lookup['identity'], entries[2].lookup['identity'])
        self.assertIn('Mat.1.1a; Mat.1.2', entries[0].body)
        self.assertIn('Ambiguity: https://example.test/ambiguity', entries[0].body)
        self.assertEqual(entries[-1].lookup['category'], 'PLACE')

    def test_preparation_and_recipe(self):
        root = Path(__file__).resolve().parents[2]
        data = json.loads((root / 'collection/recipes/language-aids-tipnr.json').read_text())
        reader = AidRecipe.from_recipe(data)
        self.assertEqual(reader.capability, 'proper_name')
        # A one-part fixture exercises the same preparation and source checks.
        reader = AidRecipe({'native_extent': {'coordinate_version': 'language-aids/tipnr/1'}, 'units': [
            {'unit_id': 'prepare-000', 'kind': 'prepare', 'native_extent': {'unit_ids': ['p000'],
             'coordinate_version': 'language-aids/tipnr/1'}, 'depends_on': []}]},
             'tipnr', STEP, 'fixture-tipnr/1', 'proper_name', 1)
        unit = reader.recipe['units'][0]
        records = reader.prepare({'kind': 'prepare', 'unit_id': unit['unit_id'], 'native_extent': unit['native_extent'],
                                  'input_refs': [{'kind': 'source_revision', 'id': 'fixture-tipnr/1'}]},
                                 Store({'fixture-tipnr/1': SYNTHETIC}))
        self.assertEqual(len(records.rows('annotation')), 4)
        self.assertTrue(records.blobs)
        self.assertEqual(records.rows('coverage')[0]['capability'], 'proper_name')

if __name__ == '__main__':
    unittest.main()

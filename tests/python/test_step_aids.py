"""B2 language aids: source-preserving lexicon and grammar preparation fixtures."""
import hashlib
import unittest

from css_preparation.adapters.step_aids import (
    AidRecipe, grammar_entries, lexicon_entries, partition_entries,
)
from css_preparation.prepare.evidence import SourceIdentity, SourceLevel
from css_preparation.prepare.records import RecordError


def entry(root, extended, word, definition):
    return '\t'.join([root, extended + ' =', extended, word,
                      'translit', 'H:N-M', 'gloss', definition])


class SourceStore:
    def __init__(self, revision, data):
        self.data = data
        self.key = 'originals/synthetic'
        identity = SourceIdentity(
            SourceLevel(revision + ':work', 'Tyndale STEP'),
            SourceLevel(revision + ':edition', 'STEP edition'),
            SourceLevel(revision + ':archive', 'B1 opaque'),
            SourceLevel(revision, 'Pinned STEP file', {
                'sha256': hashlib.sha256(data).hexdigest(),
                'byte_count': len(data), 'locator': self.key,
            }),
            'STEPBible.org/Tyndale House, CC BY 4.0', 'https://stepbible.github.io',
        )
        self.nodes = {row['id']: row for row in identity.rows()}

    def read_row(self, kind, identity):
        return self.nodes.get(identity) if kind == 'source_node' else None

    def read_blob(self, key):
        if key != self.key:
            raise KeyError(key)
        return self.data


class StepAidTest(unittest.TestCase):
    def test_homonyms_and_works_have_independent_entry_identity(self):
        text = '\n'.join([
            'eStrong\t...', 
            entry('H0001', 'H0001G', 'אָב', 'first sense<br>more'),
            entry('H0001', 'H0001H', 'אָב', 'different sense'),
        ])
        parsed = lexicon_entries(text, 'TBESH')
        self.assertEqual([e.key for e in parsed], ['H0001G', 'H0001H'])
        self.assertEqual([e.details['strong_base'] for e in parsed], ['H0001', 'H0001'])
        self.assertEqual(parsed[0].text, 'first sense<br>more')
        with self.assertRaises(RecordError):
            lexicon_entries(text + '\n' + entry('H0001', 'H0001G', 'אָב', 'duplicate'), 'TBESH')

    def test_morphology_brief_and_full_are_kept_separate(self):
        text = '''Code\tExample in English\tMeaning
G:N\tperson\tGreek noun
FULL MORPHOLOGY CODES:
N-NSM\tFunction=Noun; Case=Nominative; Number=Singular; Gender=Masculine
\tNoun Nominative Singular Masculine
\tA noun referring to a male person as subject
\t"a man speaks"
$
'''
        entries = grammar_entries(text, 'TEGMC')
        self.assertEqual([entry.key for entry in entries], ['G:N', 'N-NSM'])
        self.assertIn('Noun Nominative Singular Masculine', entries[1].text)
        self.assertEqual(entries[1].details['code_kind'], 'full')

    def test_prepared_records_keep_identity_and_text_out_of_d1(self):
        revision = 'stepdata-tbesh-5de0a47f/1'
        data = ('header\n' + entry('H0001', 'H0001G', 'אָב', 'first lexical sense')
                + '\n' + entry('H0001', 'H0001H', 'אָב', 'second lexical sense') + '\n').encode('utf-8')
        source = SourceStore(revision, data)
        scope = {'coordinate_version': 'step-language-aids/tbesh/1', 'unit_ids': ['p000']}
        unit = {'unit_id': 'prepare-000', 'kind': 'prepare', 'native_extent': scope, 'depends_on': []}
        recipe = AidRecipe({'native_extent': {'coordinate_version': scope['coordinate_version']},
                            'units': [unit]}, 'tbesh', revision, 'TBESH', 'lexicon_entry', 1)
        records = recipe.prepare({'kind': 'prepare', 'unit_id': 'prepare-000',
                                  'native_extent': scope}, source)
        self.assertEqual(len(records.rows('native_span')), 2)
        self.assertEqual(len(records.rows('annotation')), 2)
        self.assertEqual({row['capability'] for row in records.rows('coverage')},
                         {'source_context', 'lexicon_entry'})
        self.assertTrue(records.blobs)
        self.assertFalse(records.rows('text_payload'))
        details = [row['details_json'] for row in records.rows('annotation')]
        self.assertEqual({d['entry_key'] for d in details}, {'H0001G', 'H0001H'})
        self.assertEqual({d['work_id'] for d in details}, {'step:TBESH'})
        source_text = recipe.read_source(revision, source)
        self.assertIn('first lexical sense', source_text.unit('p000'))
        self.assertLess(len(records.statements()), 1000)

    def test_partition_count_must_match_reviewed_recipe(self):
        with self.assertRaises(RecordError):
            partition_entries([lexicon_entries(entry('H0001', 'H0001G', 'אָב', 'father'), 'TBESH')[0]], 2)


if __name__ == '__main__':
    unittest.main()

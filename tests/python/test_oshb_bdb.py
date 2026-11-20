import unittest
from xml.etree import ElementTree as ET

from css_preparation.adapters.oshb.bdb import read_bdb, read_lexical_index
from css_preparation.prepare.records import RecordError

COMMIT = 'a' * 40
NS = 'http://openscriptures.github.com/morphhb/namespace'
BDB = f'''<lexicon xmlns="{NS}"><part id="heb" xml:lang="he"><section id="s1">
<entry id="a"><w>אב</w><sense n="1"><def>father</def><ref r="Gen.1.1">Gen</ref></sense></entry>
<entry id="b"><w>אב</w><def>another article</def></entry></section></part></lexicon>'''
INDEX = f'''<index xmlns="{NS}"><part xml:lang="he">
<entry id="lex1"><w>אב</w><xref bdb="a" strong="1" aug="a" twot="1"/><xref bdb="b" strong="1"/></entry>
<entry id="lex2"><w>אב</w><xref strong="1"/></entry></part></index>'''


class BDBTest(unittest.TestCase):
    def test_articles_preserve_identity_and_structure(self):
        first, second = read_bdb(BDB, commit=COMMIT)
        self.assertNotEqual(first.entry_id, second.entry_id)
        self.assertEqual((first.work, first.part_id, first.language, first.section_id),
                         ('oshb-bdb', 'heb', 'he', 's1'))
        self.assertEqual(ET.fromstring(first.xml).find(f'.//{{{NS}}}ref').get('r'), 'Gen.1.1')
        self.assertNotEqual(first.entry_id, read_bdb(BDB, commit='b' * 40)[0].entry_id)

    def test_index_retains_all_source_links_and_missing_targets(self):
        first, second = read_lexical_index(INDEX, commit=COMMIT)
        self.assertEqual(first.references, (('a', '1', 'a', '1'), ('b', '1', None, None)))
        self.assertEqual(second.references, ((None, '1', None, None),))
        self.assertEqual(second.native_id, 'lex2')
        self.assertEqual(first.work, 'oshb-lexical-index')
        self.assertEqual(first.edition, f'HebrewLexicon:{COMMIT}')
        self.assertEqual(first.entry_id, f'oshb-lexical-index:{COMMIT}:lex1')
        self.assertNotEqual(first.entry_id, second.entry_id)
        self.assertNotEqual(first.entry_id, read_lexical_index(INDEX, commit='b' * 40)[0].entry_id)

    def test_rejects_wrong_roots_bad_xml_and_invalid_commit(self):
        for payload in ('<index/>', '<lexicon>', '<lexicon/>'):
            with self.subTest(payload=payload), self.assertRaises(RecordError):
                read_bdb(payload, commit=COMMIT)
        for commit in ('a' * 39, 'z' * 40, None):
            with self.subTest(commit=commit), self.assertRaises(RecordError):
                read_bdb(BDB, commit=commit)
            with self.subTest(index_commit=commit), self.assertRaises(RecordError):
                read_lexical_index(INDEX, commit=commit)
        with self.assertRaises(RecordError):
            read_lexical_index(BDB, commit=COMMIT)

    def test_duplicate_and_missing_ids_are_rejected(self):
        for bdb in (BDB.replace('id="b"', 'id="a"'), BDB.replace('id="b"', '')):
            with self.assertRaises(RecordError):
                read_bdb(bdb, commit=COMMIT)
        with self.assertRaises(RecordError):
            read_lexical_index(INDEX.replace('id="lex2"', 'id="lex1"'), commit=COMMIT)


if __name__ == '__main__':
    unittest.main()

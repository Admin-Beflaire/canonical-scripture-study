"""Levinsohn (LGNTDF) division starts placed on native verses (synthetic text only)."""
import unittest

from css_preparation.adapters.levinsohn_units import LABEL, METHOD, PROVIDER, levinsohn_starts, levinsohn_units
from css_preparation.adapters.berean_units import berean_units
from css_preparation.adapters.sblgnt_units import sblgnt_units
from css_preparation.prepare.literary import literary_spans
from css_preparation.prepare.records import RecordError
from css_preparation.prepare.unit_builder import build_units
from css_preparation.adapters.stepbible.prepare import book_text

from test_berean_sblgnt_units import native, usfm, verse, xml


def feature(*osis, kind='Specific Circumstance', bom=False):
    """The layout of the real file: BOM, XML declaration, header, then one `reference` per mark."""
    rows = ''.join(f'<reference osisRef="{o}" type="{kind}" label="" verse="x">ἐγένετο</reference>' for o in osis)
    text = ('<?xml version="1.0" encoding="utf-8" ?><feature><header><copyright>c</copyright>'
            f'<name>{kind}</name></header><references>{rows}</references></feature>')
    return ('﻿' + text).encode('utf-8') if bom else text


class LevinsohnStartsTest(unittest.TestCase):
    def test_matthew_divisions_are_division_starts_in_text_order(self):
        starts = levinsohn_starts('Mat', feature('Matt.7.28!2', 'Matt.11.1!2', 'Matt.26.1!2'))
        self.assertEqual([(s.reference, s.scale, s.label) for s in starts],
                         [('Mat.7.28', 'division', LABEL), ('Mat.11.1', 'division', LABEL), ('Mat.26.1', 'division', LABEL)])

    def test_the_verse_the_description_names_for_luke_acts_use_is_left_out(self):
        starts = levinsohn_starts('Mat', feature('Matt.7.28!2', 'Matt.9.10!2', 'Matt.11.1!2'))
        self.assertEqual([s.reference for s in starts], ['Mat.7.28', 'Mat.11.1'])

    def test_real_layout_with_a_byte_order_mark_and_other_books_in_the_file(self):
        data = feature('Matt.7.28!2', 'Mark.1.9!2', 'Luke.1.8!1', 'Acts.3.23!1', bom=True)
        self.assertEqual([s.reference for s in levinsohn_starts('Mat', data)], ['Mat.7.28'])

    def test_other_books_give_no_starts(self):
        for book in ('Mrk', 'Luk', 'Act', 'Rev'):
            self.assertEqual(levinsohn_starts(book, feature('Matt.7.28!2', 'Mark.1.9!2')), ())

    def test_wrong_feature_file_is_refused(self):
        with self.assertRaises(RecordError):
            levinsohn_starts('Mat', feature('Matt.5.3!1', kind='Reported Speech'))

    def test_empty_malformed_or_unplaced_files_are_refused(self):
        for data in ('', '<feature><references></references></feature>', '<feature><reference'):
            with self.assertRaises(RecordError):
                levinsohn_starts('Mat', data)
        with self.assertRaises(RecordError):       # references exist but none is in Matthew
            levinsohn_starts('Mat', feature('Mark.1.9!2'))

    def test_out_of_order_or_odd_references_are_refused(self):
        with self.assertRaises(RecordError):
            levinsohn_starts('Mat', feature('Matt.11.1!2', 'Matt.7.28!2'))
        with self.assertRaises(RecordError):
            levinsohn_starts('Mat', feature('Matt.7.28'))

    def test_unknown_book_is_refused(self):
        with self.assertRaises(RecordError):
            levinsohn_starts('Gen', feature('Matt.7.28!2'))

    def test_document_type_declaration_is_refused_in_any_encoding(self):
        body = feature('Matt.7.28!2').replace('<feature>', '<!DOCTYPE feature [<!ENTITY x "y">]><feature>')
        for data in (body, body.encode('utf-8'), body.encode('utf-16')):
            with self.assertRaises(RecordError):
                levinsohn_starts('Mat', data)


class LevinsohnOnNativeVersesTest(unittest.TestCase):
    def setUp(self):
        self.verses, self.component = native()
        self.order = [v.unit_id for v in self.verses]

    def test_divisions_run_to_the_next_division_and_say_they_are_verse_level(self):
        proposals = levinsohn_units(self.verses, 'Mat', feature('Matt.1.3!2', 'Matt.1.6!2'))
        self.assertEqual([[u for u, _, _ in p.segments] for p in proposals],
                         [['Mat.1.3', 'Mat.1.4', 'Mat.1.5'], ['Mat.1.6', 'Mat.1.7', 'Mat.1.8']])
        self.assertTrue(all(p.source == PROVIDER and p.method == METHOD and p.notes == {'granularity': 'verse'}
                            for p in proposals))

    def test_divisions_hold_the_sblgnt_paragraphs_and_pass_the_literary_check(self):
        lev = levinsohn_units(self.verses, 'Mat', feature('Matt.1.3!2', 'Matt.1.6!2'))
        sbl = sblgnt_units(self.verses, 'Mat', xml(f'<p>{verse(3)}{verse(4)}{verse(5)}</p>', f'<p>{verse(6)}{verse(7)}</p>'))
        units = {u.key: u for u in build_units('Mat', self.order, [*lev, *sbl])}
        divisions = {k: u for k, u in units.items() if ':division:' in k}
        paragraphs = [u for k, u in units.items() if ':paragraph:' in k]
        self.assertEqual(len(divisions), 2)
        self.assertTrue(all(u.parent_key in divisions for u in paragraphs))
        literary_spans(book_text(self.verses, self.component, 'Mat'), units.values())

    def test_berean_sections_nest_inside_a_levinsohn_division(self):
        lev = levinsohn_units(self.verses, 'Mat', feature('Matt.1.3!2', 'Matt.1.6!2'))
        ber = berean_units(self.verses, 'Mat', usfm('\\s1 First', '\\p', '\\v 3 a', '\\v 4 b', '\\s1 Second', '\\p', '\\v 5 c',
                                                    '\\s1 Third', '\\p', '\\v 6 d'))
        units = {u.key: u for u in build_units('Mat', self.order, [*lev, *ber])}
        divisions = {k for k in units if ':division:' in k}
        sections = [u for k, u in units.items() if ':section:' in k]
        self.assertEqual(len(divisions), 2)
        self.assertEqual(len(sections), 3)
        self.assertTrue(all(u.parent_key in divisions for u in sections))
        literary_spans(book_text(self.verses, self.component, 'Mat'), units.values())


if __name__ == '__main__':
    unittest.main()

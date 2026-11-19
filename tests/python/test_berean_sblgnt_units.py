"""Unit starts of Berean (USFM) and SBLGNT (XML) placed on native verses (synthetic text only)."""
import unittest

from css_preparation.adapters.berean_units import PROVIDER as BEREAN, berean_starts, berean_units
from css_preparation.adapters.sblgnt_units import PROVIDER as SBLGNT, _NAMES, sblgnt_starts, sblgnt_units
from css_preparation.adapters.stepbible.source import BOOKS
from css_preparation.adapters.stepbible.prepare import book_text, book_verses, read_component
from css_preparation.prepare.literary import literary_spans
from css_preparation.prepare.records import RecordError
from css_preparation.prepare.unit_builder import build_units
from css_preparation.prepare.unit_starts import Start, proposals_from_starts

import stepbible_fixture as fixture

COUNT = 8


def native(count=COUNT):
    lines = fixture.HEADER[:]
    for number in range(1, count + 1):
        lines.append(fixture.row(f'Mat.1.{number}#01=NKO', 'Αβγ (Abg)', 'word', 'G1111=N-NSF', 'αβγ=word',
                                 'NA28+NA27+TR+Byz'))
    component, raw = fixture.component('tagnt', lines)
    return book_verses(read_component(raw, component), component, 'Mat'), component


def usfm(*lines, book='MAT'):
    return '\n'.join([f'\\id {book} synthetic', '\\c 1', *lines])


def verses_of(proposal):
    return [unit_id for unit_id, _, _ in proposal.segments]


def paragraphs(proposals):
    return [verses_of(p) for p in proposals if p.scale == 'paragraph']


class StartsOnNativeVersesTest(unittest.TestCase):
    def setUp(self):
        self.verses, self.component = native()

    def place(self, *starts):
        return proposals_from_starts(self.verses, 'Mat', starts, source='A', method='A/1')

    def test_a_unit_runs_to_the_next_start_and_the_last_to_the_book_end(self):
        proposals = self.place(Start('Mat.1.1', 'paragraph'), Start('Mat.1.4', 'paragraph'), Start('Mat.1.7', 'paragraph'))
        self.assertEqual(paragraphs(proposals), [['Mat.1.1', 'Mat.1.2', 'Mat.1.3'], ['Mat.1.4', 'Mat.1.5', 'Mat.1.6'],
                                                 ['Mat.1.7', 'Mat.1.8']])

    def test_verses_before_the_first_start_are_in_no_unit(self):
        proposals = self.place(Start('Mat.1.3', 'paragraph'))
        self.assertEqual(paragraphs(proposals), [['Mat.1.3', 'Mat.1.4', 'Mat.1.5', 'Mat.1.6', 'Mat.1.7', 'Mat.1.8']])

    def test_two_starts_in_one_verse_are_one_boundary(self):
        proposals = self.place(Start('Mat.1.1', 'paragraph'), Start('Mat.1.3', 'paragraph'), Start('Mat.1.3', 'paragraph'))
        self.assertEqual(len(paragraphs(proposals)), 2)

    def test_segments_are_whole_verses_and_say_so(self):
        [proposal] = self.place(Start('Mat.1.7', 'section', 'Heading'))
        self.assertEqual(proposal.label, 'Heading')
        self.assertEqual(dict(proposal.notes), {'granularity': 'verse'})
        self.assertEqual([(s, 0, len(v.text)) for s, v in zip(verses_of(proposal), self.verses[6:])],
                         list(proposal.segments))

    def test_order_is_checked_within_a_scale_only(self):
        proposals = self.place(Start('Mat.1.4', 'section'), Start('Mat.1.2', 'paragraph'))
        self.assertEqual([p.scale for p in proposals], ['section', 'paragraph'])

    def test_unknown_verse_unknown_scale_and_backward_starts_are_refused(self):
        with self.assertRaises(RecordError):
            self.place(Start('Mat.9.9', 'paragraph'))
        with self.assertRaises(RecordError):
            self.place(Start('Mat.1.1', 'chapter'))
        with self.assertRaises(RecordError):
            self.place(Start('Mat.1.4', 'paragraph'), Start('Mat.1.2', 'paragraph'))

    def test_proposals_pass_the_shared_boundary_checks(self):
        proposals = self.place(Start('Mat.1.1', 'section'), Start('Mat.1.1', 'paragraph'), Start('Mat.1.5', 'paragraph'))
        units = build_units('Mat', [v.unit_id for v in self.verses], proposals)
        literary_spans(book_text(self.verses, self.component, 'Mat'), units)


class BereanTest(unittest.TestCase):
    def setUp(self):
        self.verses, _ = native()

    def starts(self, *lines, **kw):
        return [(s.reference, s.scale, s.label) for s in berean_starts('Mat', usfm(*lines, **kw))]

    def test_headings_start_sections_and_p_starts_paragraphs(self):
        found = self.starts('\\s1 The Birth', '\\r (Luke 2:1)', '\\p', '\\v 1 Text one.', '\\v 2 Text two.', '\\p',
                            '\\v 3 Text three.', '\\s1 The Visit', '\\p', '\\v 4 Text four.')
        self.assertEqual(found, [('Mat.1.1', 'section', 'The Birth'), ('Mat.1.1', 'paragraph', ''),
                                 ('Mat.1.3', 'paragraph', ''), ('Mat.1.4', 'section', 'The Visit'),
                                 ('Mat.1.4', 'paragraph', '')])

    def test_a_poetry_block_is_one_paragraph_and_blank_lines_do_not_end_it(self):
        found = self.starts('\\p', '\\v 1 Prose.', '\\q1', '\\v 2 Line one', '\\q2 line two', '\\b ', '\\q1', '\\v 3 Line three',
                            '\\b ', '\\q1', '\\v 4 Same block', '\\p', '\\v 5 Prose again')
        self.assertEqual([(r, s) for r, s, _ in found],
                         [('Mat.1.1', 'paragraph'), ('Mat.1.2', 'paragraph'), ('Mat.1.5', 'paragraph')])

    def test_the_layout_of_the_real_file_is_read(self):
        # The marker patterns of the published BSB USFM, with invented wording.
        found = self.starts('\\s1 The Genealogy', '\\r (\\ref Ruth 4:18-22|RUT 4:18-22\\ref*; \\ref Luke 3:23-38|LUK 3:23-38\\ref*)',
                            '\\p \\v 1 \\add This is the\\add* record of \\wj words\\wj*', '\\b ',
                            '\\q1 \\v 2 Line one,', '\\q1 line two.\\f + \\fr 1:2 \\ft Greek \\fqa Aram\\ft , a note\\f*', '\\b ',
                            '\\q1 \\v 3 Line three', '\\p Next:', '\\b ', '\\q1 Line four', '\\q1 \\v 4 Line five')
        self.assertEqual(found, [('Mat.1.1', 'section', 'The Genealogy'), ('Mat.1.1', 'paragraph', ''),
                                 ('Mat.1.2', 'paragraph', ''), ('Mat.1.3', 'paragraph', ''), ('Mat.1.3', 'paragraph', '')])

    def test_acrostic_letters_and_psalm_titles_are_not_verse_wording(self):
        found = self.starts('\\s1 Psalm', '\\d For the choirmaster.', '\\q1', '\\v 1 Line', '\\b ', '\\qa B', '\\q1', '\\v 2 Line')
        self.assertEqual([(r, s) for r, s, _ in found], [('Mat.1.1', 'section'), ('Mat.1.1', 'paragraph')])

    def test_a_heading_ends_a_poetry_block(self):
        found = self.starts('\\q1', '\\v 1 Line', '\\s1 Next', '\\q1', '\\v 2 Line')
        self.assertEqual([(r, s) for r, s, _ in found], [('Mat.1.1', 'paragraph'), ('Mat.1.2', 'section'),
                                                         ('Mat.1.2', 'paragraph')])

    def test_a_break_inside_a_verse_is_placed_at_that_verse(self):
        found = self.starts('\\p', '\\v 1 Start of verse', '\\p', 'rest of the same verse.', '\\v 2 Next.')
        self.assertEqual([(r, s) for r, s, _ in found], [('Mat.1.1', 'paragraph'), ('Mat.1.1', 'paragraph')])
        found = self.starts('\\p', '\\v 1 Whole verse.', '\\p', '\\v 2 Next.')
        self.assertEqual([r for r, _, _ in found], ['Mat.1.1', 'Mat.1.2'])

    def test_footnote_text_is_not_verse_wording(self):
        found = self.starts('\\p', '\\v 1 Text.', '\\p', '\\f + \\fr 1:1 \\ft a note\\f*', '\\v 2 Next.')
        self.assertEqual([r for r, _, _ in found], ['Mat.1.1', 'Mat.1.2'])

    def test_verse_bridge_starts_at_its_first_verse_and_markers_in_text_are_skipped(self):
        found = self.starts('\\p', '\\v 3-4 A \\w word|strong="G1"\\w* \\add added\\add* end.')
        self.assertEqual(found, [('Mat.1.3', 'paragraph', '')])

    def test_wrong_book_missing_id_or_structure_is_refused(self):
        with self.assertRaises(RecordError):
            berean_starts('Mat', usfm('\\p', '\\v 1 x', book='MRK'))
        with self.assertRaises(RecordError):
            berean_starts('Mat', '\\c 1\n\\p\n\\v 1 x')
        with self.assertRaises(RecordError):
            berean_starts('Mat', '\\id MAT x\n\\p\n\\v 1 x')
        with self.assertRaises(RecordError):
            berean_starts('Mat', usfm('\\p', '\\v one x'))
        with self.assertRaises(RecordError):
            berean_starts('Mat', usfm('\\s1 Only a heading'))
        with self.assertRaises(RecordError):
            berean_starts('Zzz', usfm('\\p', '\\v 1 x'))

    def test_units_carry_the_berean_attribution(self):
        proposals = berean_units(self.verses, 'Mat', usfm('\\s1 Heading', '\\p', '\\v 1 a', '\\v 2 b', '\\p', '\\v 3 c'))
        self.assertTrue(all(p.source == BEREAN for p in proposals))
        self.assertEqual([p.scale for p in proposals], ['section', 'paragraph', 'paragraph'])
        self.assertEqual(paragraphs(proposals)[0], ['Mat.1.1', 'Mat.1.2'])


def xml(*body):
    return '<book id="Matt"><title>Synthetic</title>' + ''.join(body) + '</book>'


def verse(number, text='x'):
    return f'<verse-number id="Matthew 1:{number}">1:{number}</verse-number>{text} '


class SblgntTest(unittest.TestCase):
    def setUp(self):
        self.verses, _ = native()

    def starts(self, *body):
        return [s.reference for s in sblgnt_starts('Mat', xml(*body))]

    def test_each_paragraph_starts_at_its_first_verse_number(self):
        self.assertEqual(self.starts(f'<p>{verse(1)}{verse(2)}</p>', f'<p>{verse(3)}</p>', f'<p>{verse(5)}{verse(6)}</p>'),
                         ['Mat.1.1', 'Mat.1.3', 'Mat.1.5'])

    def test_a_paragraph_that_begins_inside_a_verse_starts_at_that_verse(self):
        self.assertEqual(self.starts(f'<p>{verse(1)}first part</p>', f'<p>rest of the verse. {verse(2)}</p>'),
                         ['Mat.1.1', 'Mat.1.1'])

    def test_verse_number_text_is_enough_when_it_has_no_id(self):
        self.assertEqual(sblgnt_starts('Mat', xml('<p><verse-number>1:4</verse-number>x</p>'))[0].reference, 'Mat.1.4')

    def test_apparatus_text_is_not_verse_wording(self):
        self.assertEqual(self.starts(f'<p>{verse(1)}a</p>', f'<p><note>variant reading</note>{verse(2)}</p>'),
                         ['Mat.1.1', 'Mat.1.2'])

    def test_unsafe_or_unreadable_files_are_refused(self):
        for text in ['<!DOCTYPE book [<!ENTITY a "b">]><book/>', '<book><p>', xml('<p><verse-number>x</verse-number></p>'),
                     xml('<p>no verse number</p>')]:
            with self.assertRaises(RecordError, msg=text):
                sblgnt_starts('Mat', text)
        with self.assertRaises(RecordError):
            sblgnt_starts('Gen', xml(f'<p>{verse(1)}</p>'))

    def test_a_document_type_is_refused_in_any_encoding(self):
        text = '<!DOCTYPE book><book id="Matt"><p><verse-number>1:1</verse-number>x</p></book>'
        for raw in (text.encode('utf-16'), text.encode('utf-16-le'), text.encode('utf-8'), text):
            with self.assertRaises(RecordError):
                sblgnt_starts('Mat', raw)
        self.assertEqual(len(sblgnt_starts('Mat', text.replace('<!DOCTYPE book>', '').encode('utf-16'))), 1)

    def test_xml_of_another_book_is_refused(self):
        with self.assertRaises(RecordError):
            sblgnt_starts('Mat', '<book id="Mark"><p><verse-number id="Mark 1:1">1:1</verse-number>x</p></book>')
        with self.assertRaises(RecordError):
            sblgnt_starts('Mat', xml('<p><verse-number id="Mark 1:1">1:1</verse-number>x</p>'))
        for name in ('Matthew 1:4', 'matt 1:4', '1:4'):
            self.assertEqual(self.starts(f'<p><verse-number id="{name}">1:4</verse-number>x</p>'), ['Mat.1.4'])
        self.assertEqual([s.reference for s in sblgnt_starts('1Co', '<book id="1Cor"><p><verse-number id="1 Corinthians 2:3">2:3'
                                                                  '</verse-number>x</p></book>')], ['1Co.2.3'])

    def test_the_whole_verse_coordinate_must_match(self):
        for number in ('9:1:4', '1:4:', 'x1:4', '1:', ':4', '1-4'):
            with self.assertRaises(RecordError, msg=number):
                sblgnt_starts('Mat', xml(f'<p><verse-number>{number}</verse-number>x</p>'))

    def test_every_new_testament_book_has_names_and_no_name_is_shared(self):
        self.assertEqual(set(_NAMES), set(BOOKS['tagnt']))
        names = [name for book, found in _NAMES.items() for name in (*found, book.lower())]
        self.assertEqual(len(names), len(set(names)))

    def test_the_root_ids_and_names_of_all_27_pinned_files_are_accepted(self):
        # Root ids and verse-number names as the pinned source's 27 book files give them.
        real = {'Mat': ('Mt', 'Matthew'), 'Mrk': ('Mk', 'Mark'), 'Luk': ('Lu', 'Luke'), 'Jhn': ('Jn', 'John'),
                'Act': ('Ac', 'Acts'), 'Rom': ('Ro', 'Romans'), '1Co': ('1Co', '1 Corinthians'), '2Co': ('2Co', '2 Corinthians'),
                'Gal': ('Gal', 'Galatians'), 'Eph': ('Eph', 'Ephesians'), 'Php': ('Php', 'Philippians'),
                'Col': ('Col', 'Colossians'), '1Th': ('1Th', '1 Thessalonians'), '2Th': ('2Th', '2 Thessalonians'),
                '1Ti': ('1Tim', '1 Timothy'), '2Ti': ('2Tim', '2 Timothy'), 'Tit': ('Tit', 'Titus'),
                'Phm': ('Phm', 'Philemon'), 'Heb': ('Heb', 'Hebrews'), 'Jas': ('Jam', 'James'), '1Pe': ('1Pe', '1 Peter'),
                '2Pe': ('2Pe', '2 Peter'), '1Jn': ('1Jn', '1 John'), '2Jn': ('2Jn', '2 John'), '3Jn': ('3Jn', '3 John'),
                'Jud': ('Jud', 'Jude'), 'Rev': ('Re', 'Revelation')}
        self.assertEqual(set(real), set(BOOKS['tagnt']))
        for book, (root, name) in real.items():
            found = sblgnt_starts(book, f'<book id="{root}"><title>x</title><p><verse-number id="{name} 2:3">3'
                                        '</verse-number><w>x</w></p></book>')
            self.assertEqual([s.reference for s in found], [f'{book}.2.3'], book)
        with self.assertRaises(RecordError):
            sblgnt_starts('Mat', '<book id="Mk"><p><verse-number>1:1</verse-number>x</p></book>')

    def test_the_layout_of_the_real_file_is_read(self):
        # Words, suffixes and prefixes between verse numbers, a byte-order mark and plain-text titles, with invented words.
        def paragraph(*parts):
            return '\n  <p>\n    ' + '\n    '.join(parts) + '\n  </p>'
        def number(n):
            return f'<verse-number id="Matthew 1:{n}">{n}</verse-number>'
        words = '<w>αβγ</w>\n    <suffix>, </suffix>\n    <w>δεζ</w>\n    <suffix>. </suffix>'
        text = ('<book id="Mt">\n  <title>ΚΑΤΑ ΜΑΘΘΑΙΟΝ</title>' + paragraph('<verse-number id="Matthew 1:1">1:1</verse-number>', words)
                + paragraph(number(2), words, number(3), words)
                + paragraph('<prefix>“</prefix>', '<w>ηθι</w>', '<suffix>. </suffix>', number(4), words) + '\n</book>\n')
        found = [s.reference for s in sblgnt_starts('Mat', b'\xef\xbb\xbf' + text.encode('utf-8'))]
        self.assertEqual(found, ['Mat.1.1', 'Mat.1.2', 'Mat.1.3'])    # the third paragraph begins inside verse 3

    def test_title_text_is_skipped_but_other_wording_before_a_verse_number_is_refused(self):
        self.assertEqual(sblgnt_starts('Mat', '<book id="Mt"><title><p>Title words</p></title>'
                                              '<p><verse-number>1:1</verse-number>x</p></book>')[0].reference, 'Mat.1.1')
        with self.assertRaises(RecordError):
            sblgnt_starts('Mat', xml('<p>unmapped wording<verse-number>1:4</verse-number>x</p>'))

    def test_units_carry_the_sblgnt_attribution(self):
        proposals = sblgnt_units(self.verses, 'Mat', xml(f'<p>{verse(1)}{verse(2)}</p>', f'<p>{verse(3)}</p>'))
        self.assertTrue(all(p.source == SBLGNT and p.scale == 'paragraph' for p in proposals))
        self.assertEqual(paragraphs(proposals)[0], ['Mat.1.1', 'Mat.1.2'])


class SourcesTogetherTest(unittest.TestCase):
    def setUp(self):
        self.verses, self.component = native()
        self.order = [v.unit_id for v in self.verses]

    def build(self, *proposals):
        return {u.key: u for u in build_units('Mat', self.order, [p for group in proposals for p in group])}

    def test_same_paragraph_in_both_sources_is_one_unit_listing_both(self):
        berean = berean_units(self.verses, 'Mat', usfm('\\p', '\\v 1 a', '\\v 2 b', '\\p', '\\v 3 c'))
        sblgnt = sblgnt_units(self.verses, 'Mat', xml(f'<p>{verse(1)}{verse(2)}</p>', f'<p>{verse(3)}</p>'))
        units = self.build(berean, sblgnt)
        self.assertEqual(len(units), 2)
        self.assertTrue(all(u.notes['sources'] == [BEREAN, SBLGNT] for u in units.values()))

    def test_a_different_break_stays_its_own_unit_and_sections_nest_the_paragraphs(self):
        berean = berean_units(self.verses, 'Mat', usfm('\\s1 One', '\\p', '\\v 1 a', '\\v 2 b', '\\p', '\\v 3 c'))
        sblgnt = sblgnt_units(self.verses, 'Mat', xml(f'<p>{verse(1)}</p>', f'<p>{verse(2)}{verse(3)}</p>'))
        units = self.build(berean, sblgnt)
        found = [u for key, u in units.items() if ':paragraph:' in key]
        self.assertEqual(len(found), 4)
        self.assertTrue(all(u.parent_key == 'Mat:section:001' for u in found))
        literary_spans(book_text(self.verses, self.component, 'Mat'), units.values())


if __name__ == '__main__':
    unittest.main()

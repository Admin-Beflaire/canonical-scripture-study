"""Synthetic TVTMS cases; originals remain in protected storage."""
import unittest

from css_preparation.adapters.stepbible.format import read_words
from css_preparation.adapters.stepbible.tvtms import compare_exceptions, read_exceptions
from css_preparation.prepare.records import RecordError
from stepbible_fixture import row


def table(*rows):
    return ('Introduction\nEnglish (NRSV, ESV, KJV etc)\tHebrew MT\n'
            "'======\t'======\n\n" + '\n'.join(rows) + '\n\nOther section\tIgnored\n').encode()


class TVTMSTest(unittest.TestCase):
    def test_summary_and_compound_references(self):
        rows = read_exceptions(table('Mal.4:1\tMal.3:19', '1Ch.12:4\t1Ch.12:4,5',
                                     'Num.26:1\tNum.25:19; 26:1', 'Psa.13:5\tPsa.13:6a',
                                     'Neh.7:69\t', '*Psa.38:16\tPsa.38:17'))
        self.assertEqual(rows[1].native, ('1Ch.12.4', '1Ch.12.5'))
        self.assertEqual(rows[2].native, ('Num.25.19', 'Num.26.1'))
        self.assertEqual(rows[3].limitation, 'missing or non-whole-verse target')
        self.assertEqual(rows[4].limitation, 'missing or non-whole-verse target')
        self.assertEqual(rows[5].reader, 'Psa.38.16')

    def test_matches_differences_and_unobserved_are_separate(self):
        rows = read_exceptions(table('Mal.4:1\tMal.3:19', 'Mal.4:2\tMal.3:20',
                                     'Mal.4:3\tMal.3:21', 'Mal.4:4\tMal.3:22a'))
        words = read_words([row('Mal.4.1(3.19)#01=L', 'א'),
                            row('Mal.4.2(3.21)#01=L', 'ב'),
                            row('Mal.4.4(3.22)#01=L', 'ג')], 'hebrew')
        report = compare_exceptions(rows, words, 'Mal')
        self.assertEqual([x['status'] for x in report], ['match', 'difference', 'not_observed', 'unresolved'])
        self.assertEqual(report[1]['observed_native'], ['Mal.3.21'])

    def test_bad_or_ambiguous_summary_is_rejected(self):
        for raw in (b'No table', table('Mal.4:1\tMal.3:19', 'Mal.4:1\tMal.3:20'),
                    table('bad reader\tMal.3:19'), table('Mal.4:1\tMal.3:19') + table('Mal.4:2\tMal.3:20')):
            with self.subTest(raw=raw), self.assertRaises(RecordError):
                read_exceptions(raw)
        with self.assertRaises(RecordError):
            compare_exceptions([], [], 'Mal')

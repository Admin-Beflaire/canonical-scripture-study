"""Synthetic TVTMS cases; originals remain in protected storage."""
import unittest
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from css_preparation.adapters.stepbible.format import read_words
from css_preparation.adapters.stepbible.tvtms import compare_exceptions, read_exceptions
from css_preparation.prepare.records import RecordError
from stepbible_fixture import row, recipe


def table(*rows):
    return ('Introduction\nEnglish (NRSV, ESV, KJV etc)\tHebrew MT\n'
            "'======\t'======\n\n" + '\n'.join(rows) + '\n\nPhrases and Abbreviations to translate\n').encode()


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
        self.assertTrue(rows[5].marked)

    def test_matches_differences_and_unobserved_are_separate(self):
        rows = read_exceptions(table('Mal.4:1\tMal.3:19', 'Mal.4:2\tMal.3:20',
                                     'Mal.4:3\tMal.3:21', 'Mal.4:4\tMal.3:22a'))
        words = read_words([row('Mal.4.1(3.19)#01=L', 'א'),
                            row('Mal.4.2(3.21)#01=L', 'ב'),
                            row('Mal.4.4(3.22)#01=L', 'ג')], 'hebrew')
        report = compare_exceptions(rows, words, 'Mal')
        self.assertEqual([x['status'] for x in report], ['match', 'difference', 'not_observed', 'unresolved'])
        self.assertEqual(report[1]['observed_native'], ['Mal.3.21'])

    def test_unlisted_shift_is_reported(self):
        rows = read_exceptions(table('Mal.4:1\tMal.3:19'))
        words = read_words([row('Mal.4.1(3.19)#01=L', 'א'), row('Mal.4.2(3.20)#01=L', 'ב')], 'hebrew')
        report = compare_exceptions(rows, words, 'Mal')
        self.assertEqual([x['status'] for x in report], ['match', 'unlisted_shift'])

    def test_bad_or_ambiguous_summary_is_rejected(self):
        for raw in (b'No table', table('Mal.4:1\tMal.3:19', 'Mal.4:1\tMal.3:20'),
                    table('bad reader\tMal.3:19'), table('Mal.4:1\tMal.3:19') + table('Mal.4:2\tMal.3:20'),
                    table('Mal.4:1\tMal.3:19\n\nMal.4:2\tMal.3:20')):
            with self.subTest(raw=raw), self.assertRaises(RecordError):
                read_exceptions(raw)
        with self.assertRaises(RecordError):
            compare_exceptions([], [], 'Mal')

    def test_command_reports_input_errors_without_tracebacks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            raw = table('Mal.4:1\tMal.3:19')
            (path / 'tvtms').write_bytes(raw)
            value, _, tagged = recipe()
            (path / 'tagged').write_bytes(tagged)
            (path / 'recipe').write_text(json.dumps(value))
            base = [sys.executable, 'tools/compare_tvtms.py', '--tvtms', str(path / 'tvtms'),
                    '--tagged', str(path / 'tagged'), '--recipe', str(path / 'recipe'), '--book', 'Mal']
            def check(digest, message):
                result = subprocess.run(base + ['--tvtms-sha256', digest], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn('Traceback', result.stderr)
            digest = hashlib.sha256(raw).hexdigest()
            check('0' * 64, 'TVTMS original differs')
            check(digest, 'Book Mal is not present')
            (path / 'tagged').write_bytes(b'changed')
            check(digest, 'Retained original differs')
            value, _, _ = recipe('tagnt')
            (path / 'recipe').write_text(json.dumps(value))
            check(digest, 'compares English with Hebrew')

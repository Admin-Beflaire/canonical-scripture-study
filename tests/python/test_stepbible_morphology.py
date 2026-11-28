"""Synthetic format samples only; no upstream originals or provider operations."""

import unittest

from css_preparation.adapters.stepbible.morphology import read_morphology
from css_preparation.prepare.records import RecordError


HEBREW = """\ufeffTEHMC - Synthetic TEHMC
BRIEF LEXICAL MORPHOLOGY CODES:
Code\tExample in English\tMeaning
H:N-M\tman\tHebrew Noun (Masculine)
Ps1c\tmy\tPossessive suffix: 1st person common singular
FULL MORPHOLOGY CODES:
line 1: Codes + expansion
$
HVqp3ms\tFunction=Verb ; Stem=Qal; Form=Perfect; Person=Third
\t"Verb : Qal Perfect Third Singular Masculine"
\t"an action completed by one male person or thing"
\tExample: he rose
$
HC\tFunction=Conjunction
\tConjunction
\ta conjunction
\t"_and_"
"""
GREEK = """TEGMC - Synthetic TEGMC
BRIEF LEXICAL MORPHOLOGY CODES:
Code\tExample in English\tMeaning
G:N-F\twoman\tGreek Noun (Feminine)
N:ADV--L\tBritishly\tName Adverb of a Location
N:ADV--L\t-List\tProper Name Adverb - Location
FULL MORPHOLOGY CODES:
$
N-NSF\tFunction=Noun; Case=Nominative; Number=Singular; Gender=Feminine
\tNoun Nominative Singular Feminine
\ta female subject
\t"_woman_ gave"
$
V-PMO-1S\tFunction=Verb; Tense=Present; Voice=Middle
\tVerb Present Middle Optative 1st Singular
\tan action that hopefully happens to oneself
\t"_I am taught myself_"
\fV-PMO-3P
V-PMO-3P\t-1\tVerb\tPresent\tMiddle
V-PMO-3P\t-2\tVerb\tTense\tVoice
V-PMO-3P\t-3\tactivity\tpresent
V-PMO-3P\t-4\tan ACTION\thappens
V-PMO-3P\t-5\tan ACTION that hopefully happens\t142375\t"_they teach themselves_"\t"short"\tVerb Present Middle Optative 3rd Plural
$
X-NSN\tFunction=Indefinite pronoun; Case=Nominative
\tIndefinite pronoun Nominative Singular Neuter
\tan indefinite subject
\t"_certain_ nation"
HEB\tKJV
check no comma without "
"""


class MorphologyReaderTests(unittest.TestCase):
    def test_hebrew_brief_and_full_codes(self):
        result = read_morphology(HEBREW.encode("utf-8"), "hebrew")
        self.assertEqual(result["H:N-M"][0].grammar, "Hebrew Noun (Masculine)")
        self.assertEqual(result["Ps1c"][0].example, "my")
        full = result["HVqp3ms"][0]
        self.assertEqual(full.kind, "full")
        self.assertEqual(full.grammar, "Verb : Qal Perfect Third Singular Masculine")
        self.assertEqual(
            full.meaning, "an action completed by one male person or thing"
        )
        self.assertEqual(full.example, "Example: he rose")
        self.assertEqual(result["HC"][0].grammar, "Conjunction")
        self.assertNotIn("made-up", result)

    def test_example_with_two_quoted_phrases_is_preserved(self):
        original = read_morphology(HEBREW, "hebrew")
        self.assertEqual(original["HC"][0].example, "_and_")
        quoted = HEBREW.replace('"_and_"', '"giving to‚ rich _and_ poor": "and"')
        parsed = read_morphology(quoted, "hebrew")
        self.assertEqual(parsed["HC"][0].example, '"giving to‚ rich _and_ poor": "and"')

    def test_greek_brief_full_duplicate_and_legacy_spreadsheet_row(self):
        result = read_morphology(GREEK, "greek")
        self.assertEqual(
            result["N-NSF"][0].grammar, "Noun Nominative Singular Feminine"
        )
        self.assertEqual(result["G:N-F"][0].grammar, "Greek Noun (Feminine)")
        self.assertEqual(len(result["N:ADV--L"]), 2)
        self.assertEqual(
            [v.grammar for v in result["N:ADV--L"]],
            ["Name Adverb of a Location", "Proper Name Adverb - Location"],
        )
        self.assertEqual(
            result["V-PMO-3P"][0].grammar, "Verb Present Middle Optative 3rd Plural"
        )
        self.assertEqual(
            result["V-PMO-3P"][0].meaning, "an ACTION that hopefully happens"
        )
        self.assertEqual(result["X-NSN"][0].kind, "full")
        self.assertNotIn("KJV", result)

    def test_wrong_original_and_missing_sections_are_refused(self):
        for data, lang in [
            (HEBREW, "greek"),
            (GREEK, "hebrew"),
            ("TEHMC - Empty", "hebrew"),
        ]:
            with (
                self.subTest(lang=lang, data=data[:20]),
                self.assertRaises(RecordError),
            ):
                read_morphology(data, lang)
        with self.assertRaises(RecordError):
            read_morphology(HEBREW, "latin")
        with self.assertRaises(RecordError):
            read_morphology(b"\xff" + HEBREW.encode("utf-8"), "hebrew")

    def test_malformed_full_group_is_rejected(self):
        bad = HEBREW.replace(
            '\t"Verb : Qal Perfect Third Singular Masculine"', "not an indented grammar"
        )
        with self.assertRaises(RecordError):
            read_morphology(bad, "hebrew")


if __name__ == "__main__":
    unittest.main()

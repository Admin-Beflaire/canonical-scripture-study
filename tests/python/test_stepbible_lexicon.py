"""Small fabricated samples of the pinned STEP TBESH/TBESG eight-column layout."""

import unittest

from css_preparation.adapters.stepbible.lexicon import read_lexicon
from css_preparation.prepare.records import RecordError

COMMIT = "5de0a47f35f0fc13dfe1430d104e5db8a4285f9c"
PARAMETERS = {"commit": COMMIT}  # The prepare recipe pins the STEP source revision.
EDITION = f"STEPBible-Data:{COMMIT}"


HEBREW = (
    """\ufeffTBESH - Translators Brief lexicon of Extended Strongs for Hebrew - Synthetic
FIELD DESCRIPTIONS:
Meaning\tseparately restricted, never returned

eStrong#\tdStrong\tuStrong\tHebrew\tTransliteration\tMorph\tGloss\tMeaning
H0001\tH0001G =\tH0001G\tאָב\tav\tH:N-M\tfather\tRESTRICTED EXAMPLE ONE
H0001\tH0001H = a Part of\tH2438H, \tאָב\tav\tN:N-M-P\tfather of\tRESTRICTED EXAMPLE TWO
H0122a\tH0122A =\tH0122A\tאָדֹם\ta.dom\tH:A\tred\tRESTRICTED EXAMPLE THREE
H2148\tH2148v = a Name of\tH2148v\tזָכַר\tzakar\tH:V\tremember\tRESTRICTED EXAMPLE FOUR
"""
    + "  \n"
)

GREEK = """TBESG - Translators Brief lexicon of Extended Strongs for Greek - Synthetic
$========== PERSON(s)
A made-up note unrelated to lexical records.

eStrong\tdStrong\tuStrong\tGreek\tTransliteration\tMorph\tGloss\tAbbott-Smith lexicon (AS), with gaps occasionally filled from Middle LSJ
==============
G0001\tG0001G =\tG0001G\tα, Ἀλφα\tAlpha\tG:N-LI\tAlpha\t <b>Alpha</b> first letter (AS)
G0001\tG0001H =\tG0001H\tἆ\ta\tG:INJ\tah!\t <b>ah</b>, surprise (AS)
G2199\tG2199H =\tG2199H\t\tZebedaios\t\t[wife]\t <i>source</i>
"""


class StepLexiconTest(unittest.TestCase):
    def test_hebrew_homonyms_have_separate_native_ids_and_source_identity(self):
        rows = read_lexicon(
            HEBREW.encode("utf-8"), "hebrew", commit=PARAMETERS["commit"]
        )
        self.assertEqual(len(rows), 4)
        self.assertEqual({r.extended_strongs for r in rows[:2]}, {"H0001"})
        self.assertNotEqual(rows[0].entry_id, rows[1].entry_id)
        self.assertTrue(all(r.work == "TBESH" and r.edition == EDITION for r in rows))
        self.assertEqual(
            [r.disambiguated_strongs for r in rows[:2]], ["H0001G", "H0001H"]
        )
        self.assertEqual(rows[1].disambiguation, "= a Part of")
        self.assertEqual(rows[1].unified_strongs, "H2438H, ")
        self.assertEqual(rows[1].lemma, "אָב")
        self.assertEqual(rows[1].gloss, "father of")
        self.assertEqual(rows[2].extended_strongs, "H0122a")
        self.assertEqual(rows[3].disambiguated_strongs, "H2148v")
        self.assertTrue(all(r.definition is None for r in rows))
        self.assertNotIn("RESTRICTED", repr(rows))

    def test_greek_keeps_source_definition_and_distinct_homonyms(self):
        rows = read_lexicon(GREEK, "greek", commit=PARAMETERS["commit"])
        self.assertEqual(len(rows), 3)
        self.assertEqual([r.extended_strongs for r in rows[:2]], ["G0001", "G0001"])
        self.assertNotEqual(rows[0].entry_id, rows[1].entry_id)
        self.assertNotEqual(
            rows[0].entry_id,
            read_lexicon(HEBREW, "hebrew", commit=PARAMETERS["commit"])[0].entry_id,
        )
        self.assertTrue(all(r.work == "TBESG" and r.edition == EDITION for r in rows))
        self.assertEqual(rows[0].definition, " <b>Alpha</b> first letter (AS)")
        self.assertEqual(rows[2].lemma, "")
        self.assertEqual(rows[2].morphology, "")
        self.assertEqual(rows[2].gloss, "[wife]")

    def test_entry_identity_uses_recipe_commit_not_a_constant(self):
        first = read_lexicon(HEBREW, "hebrew", commit=PARAMETERS["commit"])[0]
        other = read_lexicon(HEBREW, "hebrew", commit="a" * 40)[0]
        self.assertEqual(first.edition, EDITION)
        self.assertEqual(first.entry_id, f"tbesh:{COMMIT}:H0001G")
        self.assertEqual(other.entry_id, f"tbesh:{'a' * 40}:H0001G")
        self.assertNotEqual(first.entry_id, other.entry_id)
        self.assertNotEqual(first.edition, other.edition)
        self.assertEqual(first.extended_strongs, other.extended_strongs)
        for bad_commit in ("5de0a47f", "g" * 40, None):
            with self.subTest(commit=bad_commit), self.assertRaises(RecordError):
                read_lexicon(HEBREW, "hebrew", commit=bad_commit)

    def test_rejects_wrong_original_header_and_invalid_utf8(self):
        cases = [
            (HEBREW, "greek"),
            (GREEK, "hebrew"),
            (HEBREW.replace("eStrong#\tdStrong", "eStrong\tdStrong"), "hebrew"),
            ("TBESH - Empty", "hebrew"),
        ]
        for data, language in cases:
            with (
                self.subTest(data=data[:25], language=language),
                self.assertRaises(RecordError),
            ):
                read_lexicon(data, language, commit=PARAMETERS["commit"])
        with self.assertRaises(RecordError):
            read_lexicon(HEBREW, "latin", commit=PARAMETERS["commit"])
        with self.assertRaises(RecordError):
            read_lexicon(
                b"\xff" + HEBREW.encode("utf-8"), "hebrew", commit=PARAMETERS["commit"]
            )

    def test_rejects_malformed_rows_and_duplicate_native_entry(self):
        for bad in [
            HEBREW.replace("H0001\tH0001H", "H0001\tH0001G"),
            HEBREW.replace("H0122a\t", "H0122a!\t"),
            HEBREW.replace("\tH:A\tred\t", "\tH:A\t"),
            HEBREW + "unstructured data row\n",
        ]:
            with self.subTest(bad=bad[-75:]), self.assertRaises(RecordError):
                read_lexicon(bad, "hebrew", commit=PARAMETERS["commit"])


if __name__ == "__main__":
    unittest.main()

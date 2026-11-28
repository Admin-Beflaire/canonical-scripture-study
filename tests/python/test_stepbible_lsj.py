"""Synthetic samples in both pinned TFLSJ originals' actual eight-column layout."""

import unittest

from css_preparation.adapters.stepbible.lsj import read_lsj
from css_preparation.prepare.records import RecordError

COMMIT = "5de0a47f35f0fc13dfe1430d104e5db8a4285f9c"
PARAMETERS = {"commit": COMMIT}

BASE = """\ufeffTFLSJ - Translators Formatted full LSJ Bible lexicon 0-5624 - STEPBible.org CC BY
See also:
TBESG - Translators Brief lexicon of Extended Strongs for Greek - STEPBible.org CC BY

 eStrong and dStrong are described above the data rows.
eStrong\tdStrong\tuStrong\tGreek\tTransliteration\tMorph\tGloss\tLSJ Meaning
====================================================================

G0001\tG0001G =\tG0001G\tα, Ἀλφα\tAlpha\tG:N-LI\tAlpha\t<b>ἄλφα</b>, first letter
G0001\tG0001H = a Name of\tH0051G\tἆ\ta\tG:INJ\tah!\t<b>ἆ</b> exclamation
G0026\tG0026 =\tG0026\tἀγάπη\tagapē\tG:N-F\tlove\t<Level1><b>__I</b></Level1> love, <ref='NT.Rom.5.8'>Rom</ref>
"""

EXTRA = """TFLSJ - Translators Formatted full LSJ Bible lexicon extra - STEPBible.org CC BY
See also:
TFLSJ - Translators Formatted full LSJ Bible lexicon 0-5624 - STEPBible.org CC BY

eStrong\tdStrong\tuStrong\tGreek\tTransliteration\tMorph\tGloss\tLSJ Meaning
====================================================================

G6000\tG6000 =\tG6000\tἀγγέλλω\tangellō\tG:V\tto report\t<b>ἀγγέλλω</b> <a title="ancient author">Refs</a>
G6202\tG6202G =\tG6202G\tὄνομα\tonoma\tG:N-N\tname\t<b>ὄνομα</b> a name
G6202\tG6202H = a Combination of\tG3461 (G1417+G3461)\tὄνομα\tonoma\tG:N-N\tproper name\t<b>ὄνομα</b> another entry
G21425\tG21425 =\tG21425\tΣιν\tsin\tG:N-LI\tSin\t
"""


class StepFullLSJTest(unittest.TestCase):
    def test_base_keeps_homonyms_separate_and_source_markup(self):
        rows = read_lsj(
            BASE.encode("utf-8"), part="0-5624", commit=PARAMETERS["commit"]
        )
        self.assertEqual(len(rows), 3)
        self.assertEqual([r.extended_strongs for r in rows[:2]], ["G0001", "G0001"])
        self.assertNotEqual(rows[0].entry_id, rows[1].entry_id)
        self.assertEqual(
            [r.disambiguated_strongs for r in rows[:2]], ["G0001G", "G0001H"]
        )
        self.assertEqual(rows[1].disambiguation, "= a Name of")
        self.assertEqual(rows[1].unified_strongs, "H0051G")
        self.assertEqual(
            rows[2].meaning,
            "<Level1><b>__I</b></Level1> love, <ref='NT.Rom.5.8'>Rom</ref>",
        )
        self.assertEqual(rows[2].lemma, "ἀγάπη")
        self.assertTrue(
            all(r.work == "TFLSJ" and r.source_part == "0-5624" for r in rows)
        )

    def test_extra_is_same_work_and_edition_but_has_own_entries(self):
        base = read_lsj(BASE, part="0-5624", commit=COMMIT)
        rows = read_lsj(EXTRA, part="extra", commit=COMMIT)
        self.assertTrue(
            all(r.work == "TFLSJ" and r.edition == base[0].edition for r in rows)
        )
        self.assertTrue(all(r.source_part == "extra" for r in rows))
        self.assertTrue(
            {r.entry_id for r in rows}.isdisjoint({r.entry_id for r in base})
        )
        self.assertEqual([r.extended_strongs for r in rows[1:3]], ["G6202", "G6202"])
        self.assertNotEqual(rows[1].entry_id, rows[2].entry_id)
        self.assertEqual(rows[2].unified_strongs, "G3461 (G1417+G3461)")
        self.assertEqual(
            rows[0].meaning, '<b>ἀγγέλλω</b> <a title="ancient author">Refs</a>'
        )
        self.assertEqual(
            rows[-1].meaning, ""
        )  # Real extra original has some empty LSJ Meaning cells.
        self.assertEqual(rows[-1].gloss, "Sin")

    def test_commit_from_recipe_changes_edition_and_entry_identity(self):
        first = read_lsj(EXTRA, part="extra", commit=PARAMETERS["commit"])[0]
        other = read_lsj(EXTRA, part="extra", commit="a" * 40)[0]
        self.assertEqual(first.edition, f"STEPBible-Data:{COMMIT}")
        self.assertEqual(first.entry_id, f"tflsj:{COMMIT}:G6000")
        self.assertNotEqual(first.entry_id, other.entry_id)
        self.assertNotEqual(first.edition, other.edition)
        self.assertEqual(first.extended_strongs, other.extended_strongs)
        for bad in ("5de0a47f", "g" * 40, None):
            with self.subTest(commit=bad), self.assertRaises(RecordError):
                read_lsj(EXTRA, part="extra", commit=bad)

    def test_wrong_part_header_and_malformed_rows_are_rejected(self):
        cases = [
            (BASE, "extra"),
            (EXTRA, "0-5624"),
            (BASE.replace("LSJ Meaning", "Notes"), "0-5624"),
            (BASE.replace("G0026\tG0026 =", "G0026\tG0001G ="), "0-5624"),
            (EXTRA.replace("G6000\tG6000 =", "G6000!\tG6000 ="), "extra"),
            (EXTRA.replace("\tG:V\tto report\t", "\tG:V\t"), "extra"),
            (
                "TFLSJ - Translators Formatted full LSJ Bible lexicon extra - STEPBible.org CC BY",
                "extra",
            ),
        ]
        for text, part in cases:
            with (
                self.subTest(part=part, sample=text[-45:]),
                self.assertRaises(RecordError),
            ):
                read_lsj(text, part=part, commit=COMMIT)
        with self.assertRaises(RecordError):
            read_lsj(BASE, part="other", commit=COMMIT)
        with self.assertRaises(RecordError):
            read_lsj(b"\xff" + BASE.encode("utf-8"), part="0-5624", commit=COMMIT)


if __name__ == "__main__":
    unittest.main()

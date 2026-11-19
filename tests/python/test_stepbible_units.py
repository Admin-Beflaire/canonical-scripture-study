"""Literary units from the Masoretic paragraph markers (synthetic TAHOT-layout files only)."""
import unittest

from css_preparation.adapters.stepbible.prepare import book_text, book_verses, read_component
from css_preparation.adapters.stepbible.units import METHOD, masoretic_units
from css_preparation.prepare.literary import literary_spans
from css_preparation.prepare.records import RecordError

import stepbible_fixture as fixture

PE, SAMEKH = 'פ', 'ס'


def verse_rows(reference, words):
    return [fixture.row(f'{reference}#{n:02d}=L', word, 'x', 'y', '{H1234}', 'HNcfsa')
            for n, word in enumerate(words, start=1)]


def book(*verses, source='tahot'):
    lines = fixture.HEADER[:]
    for reference, words in verses:
        lines += verse_rows(reference, words)
    component, raw = fixture.component(source, lines)
    parsed = book_verses(read_component(raw, component), component, 'Exo')
    return parsed, component


def wording(verses, unit):
    by_id = {verse.unit_id: verse.text for verse in verses}
    return ' | '.join(by_id[unit_id][start:stop] for unit_id, start, stop in unit.segments)


class MasoreticUnitsTest(unittest.TestCase):
    def setUp(self):
        self.verses, self.component = book(
            ('Exo.1.1', ['אָבֹג', 'דֶה\\׃', SAMEKH]),
            ('Exo.1.2', ['וָז', 'חַט\\׃', PE]),
            ('Exo.1.3', ['יָכ', 'נֶס\\׃']))
        self.units = {unit.key: unit for unit in masoretic_units(self.verses, self.component, 'Exo')}

    def test_petuchah_ends_a_section_and_setumah_divides_it_into_parts(self):
        self.assertEqual(sorted(self.units), ['Exo:masoretic:s001', 'Exo:masoretic:s001:p01',
                                              'Exo:masoretic:s001:p02', 'Exo:masoretic:s002'])
        first = self.units['Exo:masoretic:s001']
        self.assertEqual([s[0] for s in first.segments], ['Exo.1.1', 'Exo.1.2'])
        self.assertEqual(wording(self.verses, self.units['Exo:masoretic:s001:p01']), 'אָבֹג דֶה׃')
        self.assertEqual(wording(self.verses, self.units['Exo:masoretic:s001:p02']), 'וָז חַט׃')
        self.assertEqual(wording(self.verses, self.units['Exo:masoretic:s002']), 'יָכ נֶס׃')

    def test_parts_name_their_parent_and_closing_marker(self):
        part = self.units['Exo:masoretic:s001:p01']
        self.assertEqual(part.parent_key, 'Exo:masoretic:s001')
        self.assertEqual(part.notes['marker_closing'], 'setumah')
        self.assertEqual(self.units['Exo:masoretic:s001'].notes['marker_closing'], 'petuchah')
        self.assertEqual(self.units['Exo:masoretic:s002'].notes['marker_closing'], 'book end')
        self.assertIsNone(self.units['Exo:masoretic:s001'].parent_key)
        self.assertNotIn('Exo:masoretic:s002:p01', self.units)

    def test_no_marker_text_is_in_any_unit(self):
        for unit in self.units.values():
            # A marker is a stand-alone token; a word may end in the same letter.
            self.assertNotIn(PE, wording(self.verses, unit).split())
            self.assertNotIn(SAMEKH, wording(self.verses, unit).split())

    def test_attribution_comes_from_the_adapter_and_boundaries_are_agreed(self):
        for unit in self.units.values():
            self.assertEqual(unit.method, METHOD)
            self.assertEqual(unit.boundary_status, 'agreed')
            self.assertTrue(unit.provider)

    def test_units_pass_the_shared_boundary_checks(self):
        text = book_text(self.verses, self.component, 'Exo')
        specs = literary_spans(text, self.units.values())
        self.assertEqual({spec.kind for spec in specs}, {'literary_unit'})
        self.assertEqual(len(specs), 4)

    def test_marker_inside_a_verse_splits_that_verse(self):
        verses, component = book(('Exo.1.1', ['אָבֹג', PE, 'דֶה\\׃']), ('Exo.1.2', ['וָז\\׃']))
        units = masoretic_units(verses, component, 'Exo')
        self.assertEqual([wording(verses, unit) for unit in units], ['אָבֹג', 'דֶה׃ | וָז׃'])
        literary_spans(book_text(verses, component, 'Exo'), units)

    def test_text_without_markers_is_one_section_with_no_parts(self):
        verses, component = book(('Exo.1.1', ['אָבֹג\\׃']), ('Exo.1.2', ['וָז\\׃']))
        [unit] = masoretic_units(verses, component, 'Exo')
        self.assertEqual(unit.key, 'Exo:masoretic:s001')
        self.assertEqual(unit.notes['marker_closing'], 'book end')

    def test_consecutive_markers_and_a_final_marker_make_no_empty_unit(self):
        verses, component = book(('Exo.1.1', ['אָבֹג\\׃', PE, PE]), ('Exo.1.2', ['וָז\\׃', SAMEKH]))
        units = masoretic_units(verses, component, 'Exo')
        self.assertEqual([wording(verses, unit) for unit in units if unit.parent_key is None], ['אָבֹג׃', 'וָז׃'])
        literary_spans(book_text(verses, component, 'Exo'), units)

    def test_greek_text_is_refused(self):
        verses, component = book(('Exo.1.1', ['אָבֹג\\׃']))
        greek, _ = fixture.component('tagnt')
        with self.assertRaises(RecordError):
            masoretic_units(verses, greek, 'Mat')


if __name__ == '__main__':
    unittest.main()

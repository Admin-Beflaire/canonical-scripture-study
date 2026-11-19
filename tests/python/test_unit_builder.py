"""Unit builder: merging, scales and nesting (synthetic verses)."""
import unittest

from css_preparation.prepare.records import RecordError
from css_preparation.prepare.unit_builder import Proposal, build_units

ORDER = [f'Mat.1.{n}' for n in range(1, 9)]


def span(first, last):
    return tuple((f'Mat.1.{n}', 0, 10) for n in range(first, last + 1))


def proposal(source, scale, first, last, label='x', **kw):
    return Proposal(source, f'{source}/1', scale, label, span(first, last), **kw)


class BuilderTest(unittest.TestCase):
    def units(self, *proposals):
        return {u.key: u for u in build_units('Mat', ORDER, proposals)}

    def test_same_verses_from_two_sources_merge_and_list_both(self):
        units = self.units(proposal('A', 'paragraph', 1, 3), proposal('B', 'paragraph', 1, 3))
        self.assertEqual(list(units), ['Mat:paragraph:001'])
        self.assertEqual(units['Mat:paragraph:001'].notes['sources'], ['A', 'B'])

    def test_different_extents_stay_separate_units(self):
        units = self.units(proposal('A', 'paragraph', 1, 3), proposal('B', 'paragraph', 1, 4))
        self.assertEqual(len(units), 2)
        self.assertTrue(all(u.boundary_status == 'agreed' and not u.alternatives for u in units.values()))

    def test_separate_stretches_are_separate_units(self):
        units = self.units(proposal('A', 'paragraph', 1, 2), proposal('A', 'paragraph', 3, 4))
        self.assertEqual(set(units), {'Mat:paragraph:001', 'Mat:paragraph:002'})

    def test_other_scales_do_not_compete_and_nest(self):
        units = self.units(proposal('A', 'paragraph', 2, 3), proposal('A', 'section', 1, 5))
        self.assertEqual(units['Mat:paragraph:001'].parent_key, 'Mat:section:001')
        self.assertIsNone(units['Mat:section:001'].parent_key)
        self.assertTrue(all(u.boundary_status == 'agreed' for u in units.values()))

    def test_discontinuous_unit_keeps_its_ordered_segments(self):
        p = Proposal('A', 'A/1', 'section', 'songs', span(1, 1) + span(5, 5))
        self.assertEqual(len(build_units('Mat', ORDER, [p])[0].segments), 2)

    def test_bad_input_is_refused(self):
        for bad in (proposal('A', 'chapterish', 1, 2), Proposal('A', 'm', 'paragraph', 'x', (('Mat.9.9', 0, 1),)),
                    Proposal('A', 'm', 'paragraph', 'x', ())):
            with self.assertRaises(RecordError):
                build_units('Mat', ORDER, [bad])


if __name__ == '__main__':
    unittest.main()

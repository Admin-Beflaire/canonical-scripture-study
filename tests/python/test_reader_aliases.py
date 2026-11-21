import unittest

from css_shared.references import reader_alias


class ReaderAliasesTest(unittest.TestCase):
    def test_declared_alias_and_unknown_reference(self):
        alias = reader_alias('2Cor.13.14')
        self.assertEqual(alias['to'], '2Cor.13.13')
        self.assertIn('KJV, ESV and NIV', alias['note'])
        self.assertIsNone(reader_alias('2Cor.13.15'))

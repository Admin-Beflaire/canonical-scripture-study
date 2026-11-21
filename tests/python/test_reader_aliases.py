import unittest
import json
from pathlib import Path

from css_shared.references import reader_alias


class ReaderAliasesTest(unittest.TestCase):
    def test_declared_alias_and_unknown_reference(self):
        fixture = json.loads((Path(__file__).resolve().parents[1] / 'conformance/reader-aliases.v1.json').read_text())
        for case in fixture['cases']:
            alias = reader_alias(case['reference'])
            self.assertEqual(alias['to'] if alias else None, case['target'])

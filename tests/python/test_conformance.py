"""The same language-neutral cases are exercised by the TypeScript test suite."""

from copy import deepcopy
import json
from pathlib import Path
import unittest

from css_shared import (
    assert_reference,
    extract_scalar_segments,
    mappings_for,
    parse_reference,
    serialize_reference,
)

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[1] / "conformance/native-reference.v1.json")
    .read_text(encoding="utf-8")
)
if FIXTURES["fixture_version"] != "native-reference-conformance/1":
    raise ValueError("Unsupported conformance fixture version")


class ConformanceTests(unittest.TestCase):
    def test_reference_cases(self):
        for case in FIXTURES["references"]:
            with self.subTest(case=case["id"]):
                if case["valid"]:
                    assert_reference(case["input"])
                    self.assertEqual(serialize_reference(case["input"]), case["serialized"])
                    self.assertEqual(parse_reference(case["serialized"]), case["input"])
                else:
                    with self.assertRaises((ValueError, TypeError, KeyError)):
                        assert_reference(case["input"])

    def test_parse_cases(self):
        for case in FIXTURES["parse"]:
            with self.subTest(case=case["id"]):
                with self.assertRaises((ValueError, TypeError, KeyError)):
                    parse_reference(case["input"])

    def test_extraction_cases(self):
        for case in FIXTURES["extraction"]:
            with self.subTest(case=case["id"]):
                if case["valid"]:
                    self.assertEqual(
                        extract_scalar_segments(case["reference"], case["basis"]),
                        case["expected"],
                    )
                else:
                    with self.assertRaises((ValueError, TypeError, KeyError)):
                        extract_scalar_segments(case["reference"], case["basis"])

    def test_mapping_cases(self):
        for case in FIXTURES["mappings"]:
            with self.subTest(case=case["id"]):
                snapshot = deepcopy(case["mappings"])
                if case["valid"]:
                    result = mappings_for(case["reference"], case["mappings"])
                    self.assertEqual(result, case["expected"])
                    if case.get("check_detached"):
                        result[0]["to"].reverse()
                        self.assertEqual(case["mappings"], snapshot)
                else:
                    with self.assertRaises((ValueError, TypeError, KeyError)):
                        mappings_for(case["reference"], case["mappings"])


if __name__ == "__main__":
    unittest.main()

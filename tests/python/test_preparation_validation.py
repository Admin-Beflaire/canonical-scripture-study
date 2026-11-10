"""The shared schema-subset checker covers every keyword the evidence contracts use."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from css_preparation import validation
from css_preparation.validation import SchemaSubset

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = json.loads((ROOT / 'tests/conformance/evidence-records.v1.json').read_text(encoding='utf-8'))
INDEXES = json.loads((ROOT / 'tests/conformance/indexes/fixture.json').read_text(encoding='utf-8'))
RECORDS = SchemaSubset('evidence-records.v1.schema.json')
SEGMENTS = SchemaSubset('indexes/span-segment.v1.schema.json')


class ValidationTest(unittest.TestCase):
    def test_every_conformance_record_passes_its_named_definition(self):
        for fixture in (EVIDENCE['records'], INDEXES['evidence_delta']):
            for kind, rows in fixture.items():
                for row in rows:
                    self.assertEqual(RECORDS.errors(kind, row), [], (kind, row))
                    self.assertEqual(RECORDS.document_errors(row), [], (kind, row))
        for row in INDEXES['span_segments']:
            self.assertEqual(SEGMENTS.document_errors(row), [], row)

    def test_nested_native_reference_and_body_rules_are_enforced(self):
        span = EVIDENCE['records']['native_span'][2]
        for change in ({'segments_json': []}, {'native_order': 9007199254740992}, {'reading_kind': 'guess'},
                       {'body_ranges_json': [{'segment_ordinal': 0}]}, {'answer': 'not a record field'},
                       {'segments_json': [{'unit_id': 'u', 'start': -1, 'end': 1}]}):
            self.assertNotEqual(RECORDS.errors('native_span', {**span, **change}), [], change)

    def test_one_of_any_of_and_conditional_shapes(self):
        package = deepcopy(EVIDENCE['records']['study_package'][0])
        package['source_refs_json'][1]['reference'] = package['source_refs_json'][0]['reference']
        self.assertIn('exactly one', ' '.join(RECORDS.errors('study_package', package)))
        statement = {**EVIDENCE['records']['character_statement'][0], 'owner_approval_ref': 7}
        self.assertNotEqual(RECORDS.errors('character_statement', statement), [])
        selection = {'singleton_id': 1, 'current_release_id': None, 'previous_release_id': 'r-1'}
        self.assertNotEqual(RECORDS.errors('release_selection', selection), [])
        self.assertEqual(RECORDS.errors('release_selection', {**selection, 'current_release_id': 'r-2'}), [])
        self.assertNotEqual(RECORDS.errors('admission', {**INDEXES['evidence_delta']['admission'][0],
                                                         'both_hosts_eligible': 1}), [])
        self.assertNotEqual(SEGMENTS.document_errors({**INDEXES['span_segments'][0], 'start_order': True}), [])

    def test_unknown_keywords_and_references_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'Unsupported schema keyword'):
            RECORDS._check({'contains': {'type': 'string'}}, [], 'root', [], {})
        with self.assertRaisesRegex(RuntimeError, 'Unknown schema reference'):
            RECORDS._check({'$ref': 'urn:css:absent:1'}, {}, '$', [], {})
        with self.assertRaisesRegex(RuntimeError, 'Unknown schema reference'):
            RECORDS._check({'$ref': 'urn:css:native-reference:1#/properties/absent'}, {}, '$', [], {})
        self.assertIn('urn:css:native-reference:1', validation._identified())


if __name__ == '__main__':
    unittest.main()

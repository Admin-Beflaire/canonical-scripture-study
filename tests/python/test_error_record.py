"""The safe error record keeps what failed and where, and nothing else."""

import json
import unittest

from css_shared.error_record import OwnMessage, annotation, error_record, record_text


class OwnError(OwnMessage, ValueError):
    pass


def raised(error):
    try:
        raise error
    except BaseException as caught:
        return caught


class ErrorRecordTests(unittest.TestCase):
    def build(self, error, **fields):
        return error_record(
            raised(error),
            tool="prepare",
            stage="building_output",
            code="failed_unit",
            **fields,
        )

    def test_our_own_message_is_kept_and_located(self):
        record = self.build(
            OwnError("Gen.3 line 1204, field morph: expected a morphology code")
        )
        self.assertEqual(
            record["message"],
            "Gen.3 line 1204, field morph: expected a morphology code",
        )
        self.assertEqual(record["error"], "OwnError")
        self.assertEqual(record["at"][-1]["function"], "raised")
        self.assertEqual(
            record["at"][-1]["file"].split("/")[-1], "test_error_record.py"
        )

    def test_a_foreign_message_is_never_stored(self):
        for error in (
            ValueError("SECRET-TOKEN in text"),
            KeyError("wording of the source"),
            json.JSONDecodeError("Expecting value near ἐν ἀρχῇ", "x", 0),
        ):
            with self.subTest(error=type(error).__name__):
                record = self.build(error)
                self.assertNotIn("message", record)
                self.assertNotIn("SECRET", record_text(record))
                self.assertNotIn("source", record_text(record))
                self.assertNotIn("ἐν", record_text(record))

    def test_only_plain_identifiers_and_counts_are_accepted(self):
        record = self.build(
            ValueError("x"),
            ids={
                "source_revision": "sbl-1.2",
                "unit": "Gen.3",
                "bad key": "a",
                "wording": "ἐν ἀρχῇ ἦν ὁ λόγος",
                "position": 1204,
            },
            counts={"rows": 12, "name": "text", "negative": -1},
            exit_code=1,
            provider_code=10000,
        )
        self.assertEqual(
            record["ids"],
            {"position": 1204, "source_revision": "sbl-1.2", "unit": "Gen.3"},
        )
        self.assertEqual(record["counts"], {"rows": 12})
        self.assertEqual((record["exit"], record["provider_code"]), (1, 10000))

    def test_the_annotation_is_one_escaped_line(self):
        record = self.build(OwnError("a%b\r\n::error::injected"))
        line = annotation(record)
        self.assertTrue(line.startswith("::error title=prepare building_output::"))
        self.assertNotIn("\n", line)
        self.assertNotIn("\r", line)
        self.assertIn("%25", line)


if __name__ == "__main__":
    unittest.main()

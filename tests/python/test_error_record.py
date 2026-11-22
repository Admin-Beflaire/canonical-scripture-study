"""The safe error record keeps what failed and where, and nothing else."""

import json
import unittest

from css_shared.error_record import (
    MAX_TEXT,
    OwnMessage,
    annotation,
    error_record,
    record_text,
)


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

    def test_library_frames_are_not_listed(self):
        record = self.build(json.JSONDecodeError("x", "y", 0))
        self.assertTrue(all("json" not in frame["file"] for frame in record["at"]))

    def test_http_status_comes_from_the_error_or_the_call(self):
        class ProviderRefusedError(OwnMessage, Exception):
            status = 503

        self.assertEqual(
            self.build(ProviderRefusedError("request refused with HTTP 503"))["http"],
            503,
        )
        self.assertEqual(self.build(ValueError("x"), http_status=404)["http"], 404)
        self.assertNotIn("http", self.build(ValueError("x"), http_status=99999))

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

    def test_a_message_has_no_line_breaks_or_control_characters_and_is_cut(self):
        record = self.build(OwnError("first\nsecond\x1b[31m " + "x" * 500))
        self.assertNotIn("\n", record["message"])
        self.assertNotIn("\x1b", record["message"])
        self.assertLessEqual(len(record["message"]), 200)

    def test_the_text_stays_within_its_limit(self):
        record = self.build(
            OwnError("y" * 500), ids={f"id{i}": "v" * 100 for i in range(30)}
        )
        self.assertLessEqual(len(record_text(record)), MAX_TEXT)
        self.assertEqual(json.loads(record_text(record))["code"], "failed_unit")

    def test_names_are_plain_sorted_and_limited(self):
        record = self.build(
            ValueError("x"),
            names=[
                "size",
                "name",
                "Bad Name",
                "x" * 5,
                "a_b",
                7,
                *[f"n{i}" for i in range(20)],
            ],
        )
        self.assertEqual(len(record["names"]), 8)
        self.assertEqual(record["names"], sorted(record["names"]))
        self.assertNotIn("Bad Name", record["names"])

    def test_the_annotation_level_is_checked(self):
        record = self.build(ValueError("x"), outcome="changes")
        self.assertTrue(
            annotation(record, "notice").startswith(
                "::notice title=prepare building_output::"
            )
        )
        with self.assertRaises(ValueError):
            annotation(record, "debug")

    def test_a_condition_without_an_error_has_no_error_fields(self):
        record = error_record(
            None, tool="quality", stage="control_check", code="no_registered_recipe"
        )
        self.assertEqual(set(record), {"v", "tool", "stage", "outcome", "code"})

    def test_the_annotation_is_one_escaped_line(self):
        record = self.build(OwnError("a%b\r\n::error::injected"))
        line = annotation(record)
        self.assertTrue(line.startswith("::error title=prepare building_output::"))
        self.assertNotIn("\n", line)
        self.assertNotIn("\r", line)
        self.assertIn("%25", line)

    def test_plain_names_are_required(self):
        for fields in (
            {"tool": "a b"},
            {"stage": "x::y"},
            {"code": "Bad Code"},
            {"outcome": "weird"},
        ):
            with self.subTest(fields=fields):
                arguments = {
                    "tool": "prepare",
                    "stage": "building_output",
                    "code": "failed_unit",
                    **fields,
                }
                with self.assertRaises(ValueError):
                    error_record(ValueError("x"), **arguments)


if __name__ == "__main__":
    unittest.main()

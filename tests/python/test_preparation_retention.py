"""Exact-input records and admission blocking (synthetic inputs)."""

import unittest

from css_preparation.acquire.retention import (
    AdmissionBasis,
    BlockedInputError,
    InputRecord,
    assert_usable,
)

PROTECTED = AdmissionBasis(
    ("owner-decision:1",), "synthetic terms", True, "not_allowed"
)
PUBLIC = AdmissionBasis(
    ("owner-decision:2",), "synthetic open licence", True, "allowed"
)


def record(admission=PROTECTED, complete=True):
    return InputRecord(
        "src-rev-1", "text", "supplied", 'etag:"1"', 17, "a" * 64, complete, admission
    )


class RetentionTest(unittest.TestCase):
    def test_an_admitted_complete_input_is_usable(self):
        assert_usable(record())
        assert_usable(record(PUBLIC))

    def test_unresolved_or_incomplete_input_is_blocked(self):
        for admission in (
            AdmissionBasis((), "terms", True, "allowed"),
            AdmissionBasis(("d",), "", True, "allowed"),
            AdmissionBasis(("d",), "terms", None, "allowed"),
            AdmissionBasis(("d",), "terms", False, "allowed"),
        ):
            with self.assertRaises(BlockedInputError):
                assert_usable(record(admission))
        with self.assertRaises(BlockedInputError):
            assert_usable(record(complete=False))
        for unsafe in ("../src", "a/../../outside", "a/./b", "a//b", "a/"):
            with self.assertRaises(BlockedInputError, msg=unsafe):
                InputRecord(
                    unsafe, "text", "route-a", "etag", 5, "a" * 64, True, PUBLIC
                )


if __name__ == "__main__":
    unittest.main()

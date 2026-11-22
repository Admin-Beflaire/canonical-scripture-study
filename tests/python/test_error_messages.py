"""Our own error messages carry identifiers and fixed words, never slices or reprs of source content."""

import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    ROOT / "services/maintenance/data-preparation/src",
    ROOT / "packages/shared-python/src",
)


def risky(node):
    """Reasons an error message f-string may repeat source content."""
    for part in ast.walk(node):
        if isinstance(part, ast.FormattedValue):
            if part.conversion == ord("r"):
                yield "a repr (!r)"
            if isinstance(part.value, ast.Subscript) and isinstance(
                part.value.slice, ast.Slice
            ):
                yield "a slice of a value"


class OwnErrorMessageTests(unittest.TestCase):
    def test_no_message_repeats_a_slice_or_repr_of_a_value(self):
        problems = []
        for folder in SOURCES:
            for path in sorted(folder.rglob("*.py")):
                for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                    if (
                        isinstance(node, ast.Raise)
                        and isinstance(node.exc, ast.Call)
                        and node.exc.args
                        and isinstance(node.exc.args[0], ast.JoinedStr)
                    ):
                        problems += [
                            f"{path.relative_to(ROOT)}:{node.lineno}: {reason}"
                            for reason in risky(node.exc.args[0])
                        ]
        self.assertEqual(problems, [])

    def test_the_check_finds_what_it_looks_for(self):
        found = set(risky(ast.parse("f'a {x!r} {y[:40]}'").body[0].value))
        self.assertEqual(found, {"a repr (!r)", "a slice of a value"})
        self.assertEqual(list(risky(ast.parse("f'a {x} {y[0]}'").body[0].value)), [])


if __name__ == "__main__":
    unittest.main()

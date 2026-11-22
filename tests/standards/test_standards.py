"""Each code standard check must fail on a new problem and pass on clean code.

The checks run on code passed through stdin, so the real configuration is
tested without touching the working tree. Existing findings are baselined and
are not what these tests cover.
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "baselines", ROOT / "tools/repository/check_baselines.py"
)
baselines = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baselines)


def run(command, code=None):
    return subprocess.run(
        command, cwd=ROOT, input=code, capture_output=True, text=True, check=False
    )


def eslint(code):
    command = ["npx", "--no-install", "eslint", "--stdin", "--stdin-filename"]
    return run([*command, "tools/example.ts"], code)


def prettier(code):
    command = ["npx", "--no-install", "prettier", "--stdin-filepath"]
    return run([*command, "tools/example.ts"], code)


def ruff_check(code):
    command = [sys.executable, "-m", "ruff", "check", "--stdin-filename"]
    return run([*command, "tools/example.py", "-"], code)


def ruff_format(code):
    command = [sys.executable, "-m", "ruff", "format", "--check", "--stdin-filename"]
    return run([*command, "tools/example.py"], code)


def typescript_function(branches=0, statements=1):
    body = "".join(f"  if (a === {n}) return {n};\n" for n in range(branches))
    body += "".join("  a += 1;\n" for _ in range(statements))
    return f"export function f(a: number): number {{\n{body}  return a;\n}}\n"


def python_function(branches=0, statements=1):
    body = "".join(f"    if a == {n}:\n        return {n}\n" for n in range(branches))
    body += "".join("    a += 1\n" for _ in range(statements))
    return f"def f(a):\n{body}    return a\n"


class TypeScriptChecks(unittest.TestCase):
    def test_clean_code_passes(self):
        self.assertEqual(eslint(typescript_function()).returncode, 0)

    def test_unused_variable_fails(self):
        result = eslint("const unused = 1;\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no-unused-vars", result.stdout)

    def test_unsafe_type_fails(self):
        result = eslint("export const a: any = 1;\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no-explicit-any", result.stdout)

    def test_complexity_limit_is_fifteen(self):
        self.assertEqual(eslint(typescript_function(branches=14)).returncode, 0)
        result = eslint(typescript_function(branches=15))
        self.assertEqual(result.returncode, 1)
        self.assertIn("complexity", result.stdout)

    def test_function_size_limit_is_eighty_lines(self):
        # The function has three more lines than its filler statements.
        self.assertEqual(eslint(typescript_function(statements=77)).returncode, 0)
        result = eslint(typescript_function(statements=78))
        self.assertEqual(result.returncode, 1)
        self.assertIn("max-lines-per-function", result.stdout)

    def test_unformatted_code_differs_from_prettier_output(self):
        unformatted = 'export const a = "x"\n'
        self.assertNotEqual(prettier(unformatted).stdout, unformatted)
        formatted = "export const a = 'x';\n"
        self.assertEqual(prettier(formatted).stdout, formatted)


class PythonChecks(unittest.TestCase):
    def test_clean_code_passes(self):
        self.assertEqual(ruff_check(python_function()).returncode, 0)
        self.assertEqual(ruff_format(python_function()).returncode, 0)

    def test_unused_import_fails(self):
        result = ruff_check("import os\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("F401", result.stdout)

    def test_bug_pattern_fails(self):
        result = ruff_check("def f(a=[]):\n    return a\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("B006", result.stdout)

    def test_complexity_limit_is_fifteen(self):
        self.assertEqual(ruff_check(python_function(branches=14)).returncode, 0)
        result = ruff_check(python_function(branches=15))
        self.assertEqual(result.returncode, 1)
        self.assertIn("C901", result.stdout)

    def test_function_size_limit_fails_a_long_function(self):
        result = ruff_check(python_function(statements=60))
        self.assertEqual(result.returncode, 1)
        self.assertIn("PLR0915", result.stdout)

    def test_a_noqa_that_suppresses_nothing_fails(self):
        result = ruff_check("x = 1  # noqa: F401\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("RUF100", result.stdout)

    def test_unformatted_code_fails_the_format_check(self):
        self.assertEqual(ruff_format("x=1\n").returncode, 1)


class DuplicateCheck(unittest.TestCase):
    def test_a_new_copy_fails(self):
        source = ROOT / "services/study/src/read/bindings.ts"
        with tempfile.TemporaryDirectory() as folder:
            for name in ("first.ts", "second.ts"):
                shutil.copyfile(source, Path(folder, name))
            result = run(
                ["npx", "--no-install", "jscpd", "--config", ".jscpd.json", folder]
            )
        self.assertEqual(result.returncode, 1)


def git(root, *arguments):
    identity = ["-c", "user.name=test", "-c", "user.email=test@example.com"]
    result = subprocess.run(
        ["git", *identity, *arguments],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def baselined_repository(root):
    """A repository with an old.ts and an old.py in the formatting baselines."""
    git(root, "init", "-q")
    for file, code in (("old.ts", "a\n"), ("old.py", "a\n"), ("other.ts", "a\n")):
        Path(root, file).write_text(code)
    Path(root, ".prettierignore").write_text("# baseline\ndist/\nold.ts\n")
    Path(root, "ruff.toml").write_text('[format]\nexclude = ["old.py"]\n')
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "baseline")
    return git(root, "rev-parse", "HEAD")


class ChangedBaselineChecks(unittest.TestCase):
    def test_a_changed_baselined_file_must_leave_the_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = baselined_repository(root)
            for file in ("old.ts", "old.py", "other.ts"):
                Path(root, file).write_text("b\n")
            git(root, "commit", "-q", "-am", "change")
            self.assertEqual(
                baselines.touched_baseline_files(root, base),
                [(".prettierignore", "old.ts"), ("ruff.toml", "old.py")],
            )

    def test_an_uncommitted_edit_to_a_baselined_file_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = baselined_repository(root)
            Path(root, "old.ts").write_text("b\n")
            Path(root, "old.py").write_text("b\n")
            git(root, "add", "old.py")
            self.assertEqual(
                baselines.touched_baseline_files(root, base),
                [(".prettierignore", "old.ts"), ("ruff.toml", "old.py")],
            )

    def test_a_changed_file_that_left_the_baseline_is_not_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = baselined_repository(root)
            Path(root, "old.ts").write_text("b\n")
            Path(root, ".prettierignore").write_text("# baseline\ndist/\n")
            git(root, "commit", "-q", "-am", "format")
            self.assertEqual(baselines.touched_baseline_files(root, base), [])

    def test_a_baselined_file_that_is_not_changed_is_not_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = baselined_repository(root)
            Path(root, "other.ts").write_text("b\n")
            git(root, "commit", "-q", "-am", "unrelated")
            self.assertEqual(baselines.touched_baseline_files(root, base), [])

    def test_the_change_that_introduces_the_baselines_is_not_held_to_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            git(root, "init", "-q")
            Path(root, "old.ts").write_text("a\n")
            git(root, "add", "-A")
            git(root, "commit", "-q", "-m", "before the baselines")
            base = git(root, "rev-parse", "HEAD")
            Path(root, "old.ts").write_text("b\n")
            Path(root, ".prettierignore").write_text("old.ts\n")
            git(root, "add", "-A")
            git(root, "commit", "-q", "-m", "introduce")
            self.assertEqual(baselines.touched_baseline_files(root, base), [])

    def test_an_unknown_base_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            baselined_repository(Path(folder))
            with self.assertRaises(RuntimeError):
                baselines.touched_baseline_files(Path(folder), None)


class BaselineChecks(unittest.TestCase):
    def test_entries_are_read_without_comments_and_folders(self):
        text = "# comment\ndist/\n\nservices/a.ts\ntools/b.mjs\n"
        self.assertEqual(
            baselines.prettier_entries(text), ["services/a.ts", "tools/b.mjs"]
        )
        self.assertEqual(
            baselines.ruff_entries('[format]\nexclude = ["a.py", "b.py"]\n'),
            ["a.py", "b.py"],
        )

    def test_copies_that_are_gone_are_stale(self):
        committed = '{"version": 1, "fingerprints": {"a": 1, "b": 1}}'
        regenerated = '{"version": 1, "fingerprints": {"a": 1}}'
        self.assertEqual(baselines.stale_fingerprints(committed, regenerated), ["b"])
        self.assertEqual(baselines.stale_fingerprints(committed, committed), [])

    def test_a_formatter_that_cannot_run_is_an_error_not_stale_entries(self):
        broken = [sys.executable, "-m", "no_such_formatter"]
        with self.assertRaises(RuntimeError):
            baselines.unformatted_files(broken, ["tools/build.mjs"], lambda r: [])

    def test_an_empty_baseline_needs_no_formatter(self):
        self.assertEqual(baselines.unformatted_files(["no-such-tool"], [], list), set())

    def test_the_formatters_report_only_files_that_still_need_formatting(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            name = Path(folder).name
            for file, code in (
                ("bad.py", "x=1\n"),
                ("good.py", "x = 1\n"),
                ("bad.ts", 'const a = "x"\n'),
                ("good.ts", "const a = 'x';\n"),
            ):
                Path(folder, file).write_text(code)
            self.assertEqual(
                baselines.ruff_unformatted([f"{name}/bad.py", f"{name}/good.py"]),
                {f"{name}/bad.py"},
            )
            self.assertEqual(
                baselines.prettier_unformatted([f"{name}/bad.ts", f"{name}/good.ts"]),
                {f"{name}/bad.ts"},
            )

    def test_missing_and_formatted_files_are_stale(self):
        entries = ["unformatted.py", "formatted.py", "missing.py"]
        self.assertEqual(
            baselines.stale(entries, {"unformatted.py"}),
            ["formatted.py", "missing.py"],
        )


if __name__ == "__main__":
    unittest.main()

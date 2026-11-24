"""Each code standard check must fail on a new problem and pass on clean code.

The checks run on code passed through stdin, so the real configuration is
tested without touching the working tree. Existing findings are baselined and
are not what these tests cover.
"""

import importlib.util
import json
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


def repository_before_lists(root):
    """A repository with one file and no exception list yet."""
    git(root, "init", "-q")
    Path(root, "old.ts").write_text("a\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "before the lists")
    return git(root, "rev-parse", "HEAD")


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
            base = repository_before_lists(root)
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


def list_repository(root):
    """A repository whose four exception lists and one inline exception are the base."""
    git(root, "init", "-q")
    files = {
        "old.ts": "// eslint-disable-next-line complexity\na\n",
        "old.py": "a  # noqa: C901\n",
        "other.ts": "a\n",
        ".prettierignore": "# baseline\ndist/\nold.ts\n",
        "ruff.toml": '[format]\nexclude = ["old.py"]\n',
        "eslint-suppressions.json": json.dumps(
            {"old.ts": {"complexity": {"count": 2}}}
        ),
        ".jscpd-baseline.json": json.dumps({"version": 1, "fingerprints": {"a": 2}}),
    }
    for file, text in files.items():
        Path(root, file).write_text(text)
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "baseline")
    return git(root, "rev-parse", "HEAD")


def growth_after(change):
    """What the growth check reports after `change(root)` on the list repository."""
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        base = list_repository(root)
        change(root)
        git(root, "add", "-A")
        return baselines.growth_problems(root, base)


class ListGrowthChecks(unittest.TestCase):
    def test_a_change_that_adds_nothing_passes(self):
        self.assertEqual(growth_after(lambda root: None), [])

    def test_lists_that_shrink_pass(self):
        def shrink(root):
            Path(root, ".prettierignore").write_text("# baseline\ndist/\n")
            Path(root, "ruff.toml").write_text("[format]\nexclude = []\n")
            Path(root, "eslint-suppressions.json").write_text("{}")
            Path(root, ".jscpd-baseline.json").write_text(
                json.dumps({"version": 1, "fingerprints": {}})
            )
            Path(root, "old.ts").write_text("a\n")
            Path(root, "old.py").write_text("a\n")

        self.assertEqual(growth_after(shrink), [])

    def test_a_new_formatter_exclusion_fails(self):
        def add(root):
            Path(root, ".prettierignore").write_text("dist/\nold.ts\nother.ts\n")
            Path(root, "ruff.toml").write_text(
                '[format]\nexclude = ["old.py", "x.py"]\n'
            )

        problems = growth_after(add)
        self.assertEqual(len(problems), 2)
        self.assertIn("other.ts was added", problems[0])
        self.assertIn("x.py was added", problems[1])

    def test_a_higher_or_new_eslint_suppression_fails(self):
        def raise_it(root):
            Path(root, "eslint-suppressions.json").write_text(
                json.dumps(
                    {
                        "old.ts": {"complexity": {"count": 3}},
                        "other.ts": {"max-lines-per-function": {"count": 1}},
                    }
                )
            )

        problems = growth_after(raise_it)
        self.assertEqual(len(problems), 2)
        self.assertIn("old.ts: complexity rose from 2 to 3", problems[0])
        self.assertIn("other.ts: max-lines-per-function rose from 0 to 1", problems[1])

    def test_a_lower_eslint_suppression_passes(self):
        def lower(root):
            Path(root, "eslint-suppressions.json").write_text(
                json.dumps({"old.ts": {"complexity": {"count": 1}}})
            )

        self.assertEqual(growth_after(lower), [])

    def test_a_new_or_repeated_copy_fails(self):
        def copy(root):
            Path(root, ".jscpd-baseline.json").write_text(
                json.dumps({"version": 1, "fingerprints": {"a": 3, "b": 1}})
            )

        problems = growth_after(copy)
        self.assertEqual(len(problems), 2)
        self.assertIn("a rose from 2 to 3", problems[0])
        self.assertIn("b rose from 0 to 1", problems[1])

    def test_a_new_inline_exception_fails(self):
        def add(root):
            Path(root, "other.ts").write_text(
                "// eslint-disable max-lines-per-function\n"
            )
            Path(root, "new.py").write_text("def f():  # noqa: C901\n    pass\n")
            Path(root, "format.ts").write_text("// prettier-ignore\n")
            Path(root, "off.py").write_text("# fmt: off\n")

        problems = growth_after(add)
        self.assertEqual(
            sorted(problem.split(":")[0] for problem in problems),
            ["format.ts", "new.py", "off.py", "other.ts"],
        )

    def test_a_second_inline_exception_in_a_file_fails(self):
        def add(root):
            Path(root, "old.py").write_text("a  # noqa: C901\nb  # noqa: F401\n")

        problems = growth_after(add)
        self.assertEqual(len(problems), 1)
        self.assertIn("old.py: noqa F401: 1 directive(s), 0 at the base", problems[0])

    def test_a_broader_directive_on_the_same_line_fails(self):
        def broaden(root):
            Path(root, "old.py").write_text("a  # noqa: C901, PLR0915\n")

        problems = growth_after(broaden)
        self.assertEqual(len(problems), 1)
        self.assertIn("old.py: noqa PLR0915", problems[0])

    def test_a_directive_that_names_no_rule_fails(self):
        def bare(root):
            Path(root, "old.py").write_text("a  # noqa\n")
            Path(root, "old.ts").write_text("// eslint-disable-next-line\na\n")

        problems = growth_after(bare)
        self.assertEqual(len(problems), 2)
        self.assertIn("old.py: noqa *", problems[0])
        self.assertIn("old.ts: eslint-disable-next-line *", problems[1])

    def test_a_next_line_directive_made_file_wide_fails(self):
        def widen(root):
            Path(root, "old.ts").write_text("/* eslint-disable complexity */\na\n")

        problems = growth_after(widen)
        self.assertEqual(len(problems), 1)
        self.assertIn("old.ts: eslint-disable complexity", problems[0])

    def test_a_directive_that_switches_off_no_more_passes(self):
        def reword(root):
            Path(root, "old.py").write_text("x = 1\na  # noqa: C901 -- reason\n")
            Path(root, "old.ts").write_text(
                "a\n// eslint-disable-next-line complexity -- reason\nb\n"
            )

        self.assertEqual(growth_after(reword), [])

    def test_a_new_ignore_pattern_fails_even_for_a_folder(self):
        def add(root):
            Path(root, ".prettierignore").write_text(
                "# baseline\ndist/\nold.ts\nservices/\n*.generated.ts\n"
            )

        problems = growth_after(add)
        self.assertEqual(len(problems), 2)
        self.assertIn("services/ was added", problems[0])
        self.assertIn("*.generated.ts was added", problems[1])

    def test_new_ruff_jscpd_and_eslint_ignores_fail(self):
        def add(root):
            Path(root, "ruff.toml").write_text(
                '[format]\nexclude = ["old.py"]\n'
                '[lint]\nignore = ["E501"]\n'
                '[lint.per-file-ignores]\n"x.py" = ["F401"]\n'
            )
            Path(root, ".jscpd.json").write_text(json.dumps({"ignore": ["a/**"]}))
            Path(root, "eslint.config.mjs").write_text(
                "export default defineConfig(globalIgnores(['dist/', 'gen/']), "
                "{ignores: ['x.ts']});\n"
            )

        # The base has no eslint.config.mjs, so its "dist/" is new as well.
        problems = growth_after(add)
        self.assertEqual(len(problems), 6)
        for entry in (
            "lint.ignore: E501",
            "x.py F401",
            "a/**",
            "gen/",
            "x.ts",
        ):
            self.assertTrue(any(entry in problem for problem in problems), entry)

    def test_an_exception_moved_to_another_file_fails(self):
        def move(root):
            Path(root, "old.py").write_text("a\n")
            Path(root, "other.py").write_text("a  # noqa: C901\n")

        self.assertEqual(len(growth_after(move)), 1)

    def test_a_removed_inline_exception_passes(self):
        def remove(root):
            Path(root, "old.ts").write_text("a\n")

        self.assertEqual(growth_after(remove), [])

    def test_text_that_only_mentions_a_tool_is_not_an_exception(self):
        def mention(root):
            Path(root, "other.py").write_text('note = "no noqa here, eslint-disable"\n')

        self.assertEqual(growth_after(mention), [])

    def test_an_exception_in_a_file_that_is_not_added_yet_still_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = list_repository(root)
            Path(root, "new.ts").write_text("// eslint-disable\n")
            self.assertEqual(len(baselines.growth_problems(root, base)), 1)

    def test_a_list_that_is_introduced_starts_from_empty(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = repository_before_lists(root)
            Path(root, ".prettierignore").write_text("old.ts\n")
            Path(root, "eslint-suppressions.json").write_text(
                json.dumps({"old.ts": {"complexity": {"count": 1}}})
            )
            git(root, "add", "-A")
            git(root, "commit", "-q", "-m", "introduce")
            problems = baselines.growth_problems(root, base)
            self.assertEqual(len(problems), 2)
            self.assertIn(".prettierignore: old.ts was added", problems[0])
            self.assertIn("old.ts: complexity rose from 0 to 1", problems[1])

    def test_an_unknown_base_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            list_repository(Path(folder))
            with self.assertRaises(RuntimeError):
                baselines.growth_problems(Path(folder), None)


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

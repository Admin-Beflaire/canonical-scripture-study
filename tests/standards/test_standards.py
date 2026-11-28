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


class BaselineChecks(unittest.TestCase):
    def test_copies_that_are_gone_are_stale(self):
        committed = '{"version": 1, "fingerprints": {"a": 1, "b": 1}}'
        regenerated = '{"version": 1, "fingerprints": {"a": 1}}'
        self.assertEqual(baselines.stale_fingerprints(committed, regenerated), ["b"])
        self.assertEqual(baselines.stale_fingerprints(committed, committed), [])

    def test_a_formatter_that_cannot_run_is_an_error_not_stale_entries(self):
        broken = [sys.executable, "-m", "no_such_formatter"]
        with self.assertRaises(RuntimeError):
            baselines.unformatted_files(broken, ["tools/build.mjs"], lambda r: [])

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

"""Fail when a baseline keeps an entry that no longer belongs in it, or grows.

The baselines are the Prettier ignore list (.prettierignore), the Ruff format
exclude list (ruff.toml), the ESLint suppressions (eslint-suppressions.json) and
the jscpd copied-code baseline (.jscpd-baseline.json). An entry must be removed
in the change that formats its file or removes its copy, so the baselines only
shrink. A change that modifies a file listed in a formatting baseline must format
it and remove it from the list, so new code in such a file is never exempt.

No exception list may grow, whatever the size of the change, and a list that is
new compared with the base starts from empty: no new list or ignore pattern (in
.prettierignore, ruff.toml, .jscpd.json or the ESLint global ignores), no higher
suppression or copy count, and no directive that switches a check off (eslint-disable,
noqa, prettier-ignore, fmt: off, jscpd:ignore) that the file did not have at the
base commit, counted per file, tool and rule, so a broader or different directive
is growth even when the number of lines is the same.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def sibling_tool(name):
    """Load another tool of this folder, so changed paths come from one place."""
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


changed_paths = sibling_tool("run_test_profile").changed_paths


def prettier_entries(text):
    """File entries of a .prettierignore; comments and folders are not baseline."""
    lines = (line.strip() for line in text.splitlines())
    return [line for line in lines if line and line[0] != "#" and line[-1] != "/"]


def ruff_entries(text):
    return tomllib.loads(text)["format"]["exclude"]


BASELINES = {".prettierignore": prettier_entries, "ruff.toml": ruff_entries}


def prettier_patterns(text):
    """Every pattern of a .prettierignore, folders included."""
    lines = (line.strip() for line in text.splitlines())
    return [line for line in lines if line and line[0] != "#"]


def ruff_patterns(text):
    """Every way ruff.toml leaves code out of a check, as "section: entry"."""
    data = tomllib.loads(text)
    lint = data.get("lint", {})
    lists = {
        "exclude": data.get("exclude", []),
        "extend-exclude": data.get("extend-exclude", []),
        "format.exclude": data.get("format", {}).get("exclude", []),
        "lint.exclude": lint.get("exclude", []),
        "lint.ignore": lint.get("ignore", []),
    }
    found = [f"{name}: {item}" for name, items in lists.items() for item in items]
    for name in ("per-file-ignores", "extend-per-file-ignores"):
        found += [
            f"lint.{name}: {path} {code}"
            for path, codes in lint.get(name, {}).items()
            for code in codes
        ]
    return found


def jscpd_patterns(text):
    return json.loads(text).get("ignore", [])


def eslint_patterns(text):
    """The strings inside globalIgnores([...]) and ignores: [...] of eslint.config.mjs."""
    blocks = re.findall(r"(?:globalIgnores\(|\bignores:)\s*\[(.*?)\]", text, re.DOTALL)
    return [p for block in blocks for p in re.findall(r"""['"]([^'"]+)['"]""", block)]


# Everything that leaves files or findings out of a check, to compare with the base.
IGNORE_LISTS = {
    ".prettierignore": prettier_patterns,
    "ruff.toml": ruff_patterns,
    ".jscpd.json": jscpd_patterns,
    "eslint.config.mjs": eslint_patterns,
}


def listed(patterns, text):
    """The entries of an ignore list; a file that does not exist is empty."""
    return patterns(text) if text else []


def entries_of(name, text):
    return listed(BASELINES[name], text)


def committed_text(root, base, name):
    result = subprocess.run(
        ["git", "show", f"{base}:{name}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else ""


def working_tree_paths(root):
    """Paths with staged or unstaged edits, so a local run sees uncommitted work."""
    result = subprocess.run(
        ["git", "diff", "--name-only", "-z", "HEAD"],
        cwd=root,
        capture_output=True,
        check=True,
    )
    return [p for p in result.stdout.decode("utf-8").split("\0") if p]


def touched_baseline_files(root, base):
    """Baselined files this change modified while keeping them in the baseline.

    Committed changes since the base and uncommitted edits both count. Only files
    that were already in a baseline at the base commit count, so the change that
    introduces the baselines is not held to them.
    """
    changed = changed_paths(base, root)
    if changed is None:
        raise RuntimeError("No base commit to compare with; set CHECK_BASE")
    changed = set(changed) | set(working_tree_paths(root))
    touched = []
    for name in BASELINES:
        file = root / name
        now = file.read_text(encoding="utf-8") if file.is_file() else ""
        before = entries_of(name, committed_text(root, base, name))
        after = entries_of(name, now)
        touched += [
            (name, path) for path in changed if path in before and path in after
        ]
    return touched


# Inline exceptions are lists too: a comment that switches a check off for code.
INLINE_EXCEPTION = (
    r"(//|/\*|#)[[:space:]]*"
    r"(eslint-disable|noqa\b|ruff:[[:space:]]*noqa|prettier-ignore"
    r"|fmt:[[:space:]]*(off|skip)|jscpd:ignore)"
)
CODE_FILES = ("*.ts", "*.mjs", "*.js", "*.py")
# The checks and their tests name the comments they look for.
NOT_COUNTED = (
    ":(exclude)tests/standards",
    ":(exclude)tools/repository/check_baselines.py",
)


def eslint_counts(text):
    """Suppressed violations by "file: rule"; no file means no suppressions."""
    if not text:
        return {}
    return {
        f"{path}: {rule}": entry["count"]
        for path, rules in json.loads(text).items()
        for rule, entry in rules.items()
    }


def jscpd_counts(text):
    return json.loads(text)["fingerprints"] if text else {}


def risen(before, after):
    """Keys whose count is higher than at the base, as (key, base, now)."""
    return [
        (key, before.get(key, 0), count)
        for key, count in sorted(after.items())
        if count > before.get(key, 0)
    ]


DIRECTIVE = re.compile(
    r"(?://|/\*|#)\s*(eslint-disable-next-line|eslint-disable-line|eslint-disable"
    r"|ruff:\s*noqa|noqa|prettier-ignore|fmt:\s*(?:off|skip)"
    r"|jscpd:ignore(?:-start|-end)?)\b(.*)"
)
RUFF_CODE = re.compile(r"\b[A-Z]{1,4}[0-9]{1,4}\b")
ESLINT_RULE = re.compile(r"[@\w][\w@/.-]*")


def directive_rules(tool, tail):
    """The rules a directive switches off; none named means every rule ("*")."""
    if tool.startswith("eslint"):
        names = ESLINT_RULE.findall(re.split(r"\s--\s|\*/", tail, maxsplit=1)[0])
    elif tool.endswith("noqa"):
        names = RUFF_CODE.findall(tail)
    else:
        names = []
    return names or ["*"]


def inline_counts(root, base=None):
    """Directives that switch a check off, by "file: tool rule", at the base or now.

    A directive naming two rules counts once for each, so broadening one (`noqa: C901`
    to `noqa: C901, PLR0915`), making it cover every rule or widening an ESLint line
    directive to the whole file is growth, while replacing one by another that
    switches off no more is not.
    """
    command = ["git", "grep", "-n", "-I", "-E", "-e", INLINE_EXCEPTION]
    command += [base] if base else ["--untracked"]
    result = subprocess.run(
        [*command, "--", *CODE_FILES, *NOT_COUNTED],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("git grep could not read the inline exceptions")
    prefix = f"{base}:" if base else ""
    counts = {}
    for line in result.stdout.splitlines():
        path, _, text = line.removeprefix(prefix).split(":", 2)
        found = DIRECTIVE.search(text)
        tool, tail = (re.sub(r"\s+", "", found[1]), found[2]) if found else ("?", text)
        for rule in directive_rules(tool, tail):
            key = f"{path}: {tool} {rule}"
            counts[key] = counts.get(key, 0) + 1
    return counts


def read(root, name):
    file = root / name
    return file.read_text(encoding="utf-8") if file.is_file() else ""


def growth_problems(root, base):
    """What this change added to an exception list, compared with the base commit.

    Every list may only shrink, whatever the size of the change. A list or config
    that did not exist at the base counts as empty there, so it cannot be used to
    introduce exceptions.
    """
    if not base:
        raise RuntimeError("No base commit to compare with; set CHECK_BASE")
    problems = []
    for name, patterns in IGNORE_LISTS.items():
        old = set(listed(patterns, committed_text(root, base, name)))
        problems += [
            f"{name}: {entry} was added; lists only shrink, fix the code instead"
            for entry in listed(patterns, read(root, name))
            if entry not in old
        ]
    for name, counts, advice in (
        ("eslint-suppressions.json", eslint_counts, "fix the code, do not suppress it"),
        (".jscpd-baseline.json", jscpd_counts, "remove the copy, do not record it"),
    ):
        was_counts = counts(committed_text(root, base, name))
        problems += [
            f"{name}: {key} rose from {was} to {now}; {advice}"
            for key, was, now in risen(was_counts, counts(read(root, name)))
        ]
    problems += [
        f"{key}: {now} directive(s), {was} at the base; fix the code instead"
        for key, was, now in risen(inline_counts(root, base), inline_counts(root))
    ]
    return problems


def base_revision():
    """The commit this change is compared with: CHECK_BASE, else origin/main."""
    if os.environ.get("CHECK_BASE"):
        return os.environ["CHECK_BASE"]
    result = subprocess.run(
        ["git", "rev-parse", "origin/main"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def stale(entries, unformatted):
    """Entries whose file is missing or already formatted."""
    return [entry for entry in entries if entry not in unformatted]


def stale_fingerprints(committed, regenerated):
    """jscpd copies in the committed baseline that the code no longer has."""
    gone = set(json.loads(committed)["fingerprints"])
    return sorted(gone - set(json.loads(regenerated)["fingerprints"]))


def unformatted_files(command, entries, report):
    """The existing entries that the formatter check still reports.

    A formatter that cannot run is an error, never a reason to call every entry
    stale: the formatter exits with 1 only when it reports files.
    """
    existing = [entry for entry in entries if (ROOT / entry).is_file()]
    if not existing:
        return set()
    result = subprocess.run(
        [*command, *existing], cwd=ROOT, capture_output=True, text=True, check=False
    )
    reported = set(report(result)) & set(existing)
    if result.returncode not in (0, 1) or (result.returncode == 1 and not reported):
        raise RuntimeError(f"{command[0]} could not check the baseline")
    return reported


def prettier_unformatted(entries):
    with tempfile.TemporaryDirectory() as folder:
        no_ignores = Path(folder, "empty")
        no_ignores.write_text("")
        command = ["npx", "--no-install", "prettier", "--list-different"]
        command += ["--ignore-path", str(no_ignores)]
        return unformatted_files(command, entries, lambda r: r.stdout.split())


def ruff_unformatted(entries):
    command = [sys.executable, "-m", "ruff", "format", "--check"]
    command += ["--output-format", "concise"]
    return unformatted_files(
        command,
        entries,
        lambda r: [
            line.split(":", 1)[0] for line in (r.stdout + r.stderr).splitlines()
        ],
    )


def jscpd_stale():
    committed = ROOT / ".jscpd-baseline.json"
    with tempfile.TemporaryDirectory() as folder:
        copy = Path(folder, "baseline.json")
        shutil.copyfile(committed, copy)
        command = ["npx", "--no-install", "jscpd", "--baseline", str(copy)]
        result = subprocess.run(
            [*command, "--update-baseline"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("jscpd could not check the baseline")
        return stale_fingerprints(
            committed.read_text(encoding="utf-8"), copy.read_text(encoding="utf-8")
        )


def main():
    prettier = prettier_entries((ROOT / ".prettierignore").read_text(encoding="utf-8"))
    ruff = ruff_entries((ROOT / "ruff.toml").read_text(encoding="utf-8"))
    problems = [
        f"{name}: remove from {baseline}; the file is missing or already formatted"
        for baseline, entries, unformatted in (
            (".prettierignore", prettier, prettier_unformatted(prettier)),
            ("ruff.toml", ruff, ruff_unformatted(ruff)),
        )
        for name in stale(entries, unformatted)
    ]
    problems += [
        f"{copy}: remove from .jscpd-baseline.json (npx jscpd --update-baseline); the copy is gone"
        for copy in jscpd_stale()
    ]
    base = base_revision()
    problems += [
        f"{path}: changed while listed in {name}; format it and remove it from {name}"
        for name, path in touched_baseline_files(ROOT, base)
    ]
    problems += growth_problems(ROOT, base)
    print(
        "\n".join(problems)
        or "Baselines list only what still needs fixing and have not grown."
    )
    return 1 if problems else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        sys.exit(str(error))

"""Fail when a baseline keeps an entry that no longer belongs in it.

The baselines are the Prettier ignore list (.prettierignore), the Ruff format
exclude list (ruff.toml) and the jscpd copied-code baseline
(.jscpd-baseline.json). An entry must be removed in the change that formats
its file or removes its copy, so the baselines only shrink. A change that
modifies a file listed in a formatting baseline must format it and remove it
from the list, so new code in such a file is never exempt.
"""

import importlib.util
import json
import os
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


def entries_of(name, text):
    """The entries of a baseline file; a file that does not exist is empty."""
    return BASELINES[name](text) if text else []


def committed_text(root, base, name):
    result = subprocess.run(
        ["git", "show", f"{base}:{name}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else ""


def touched_baseline_files(root, base):
    """Baselined files this change modified while keeping them in the baseline.

    Only files that were already in a baseline at the base commit count, so the
    change that introduces the baselines is not held to them.
    """
    changed = changed_paths(base, root)
    if changed is None:
        raise RuntimeError("No base commit to compare with; set CHECK_BASE")
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
    problems += [
        f"{path}: changed while listed in {name}; format it and remove it from {name}"
        for name, path in touched_baseline_files(ROOT, base_revision())
    ]
    print("\n".join(problems) or "Baselines list only what still needs fixing.")
    return 1 if problems else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        sys.exit(str(error))

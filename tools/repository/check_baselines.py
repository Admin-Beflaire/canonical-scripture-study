"""Fail when a baseline keeps an entry that no longer belongs in it.

The baselines are the Prettier ignore list (.prettierignore), the Ruff format
exclude list (ruff.toml) and the jscpd copied-code baseline
(.jscpd-baseline.json). An entry must be removed in the change that formats
its file or removes its copy, so the baselines only shrink.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def prettier_entries(text):
    """File entries of a .prettierignore; comments and folders are not baseline."""
    lines = (line.strip() for line in text.splitlines())
    return [line for line in lines if line and line[0] != "#" and line[-1] != "/"]


def ruff_entries(text):
    return tomllib.loads(text)["format"]["exclude"]


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
    print("\n".join(problems) or "Baselines list only what still needs fixing.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

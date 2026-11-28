"""Credential-free check profiles and conservative changed-path routing."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PROFILES = ("typescript", "python", "repository", "standards")
# The tests of the code-standard checkers run only when the checkers or their settings change.
STANDARD_TOOLS = (
    "tools/",
    "tests/standards/",
    ".github/workflows/checks.yml",
    "package.json",
    "package-lock.json",
    "requirements-dev.txt",
    "ruff.toml",
    "eslint.config.mjs",
    ".prettierrc",
    ".jscpd.json",
)


def select_suites(paths):
    selected = set()
    for path in paths:
        typescript_home = path.startswith(
            (
                "services/study/",
                "services/maintenance/control/",
                "packages/shared/",
                "tests/shared/",
                "tests/study/",
            )
        )
        python_home = path.startswith(
            (
                "services/maintenance/data-preparation/",
                "packages/shared-python/",
                "tests/python/",
            )
        )
        suffix = Path(path).suffix
        if (typescript_home and suffix == ".py") or (
            python_home
            and suffix in {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
        ):
            selected.update(PROFILES)
            continue
        if path.startswith(("collection/", "schemas/", "tests/conformance/")):
            selected.update(("typescript", "python"))
        elif path.startswith(
            (
                "services/study/",
                "services/maintenance/control/",
                "packages/shared/",
                "tests/shared/",
                "tests/study/",
            )
        ):
            selected.add("typescript")
        elif path.startswith("packages/shared-python/"):
            # The deployment and provisioning scripts import it, so their tests run too.
            selected.update(("python", "repository"))
        elif (
            path.startswith(
                (
                    "services/maintenance/data-preparation/",
                    "tests/python/",
                )
            )
            or path == ".python-version"
        ):
            selected.add("python")
        elif path.startswith(
            (".github/", "infrastructure/", "tools/", "tests/repository/")
        ):
            selected.update(PROFILES)
        elif path in {"package.json", "package-lock.json"} or path.startswith(
            "tsconfig"
        ):
            selected.update(PROFILES)
        elif not path.endswith((".md", ".txt")) and path != "LICENSE":
            # New runtime/config homes must not escape checks before being classified.
            selected.update(PROFILES)
    return sorted(selected)


def select_profiles(paths):
    """Code standards run with any code change, and alone for their locked tools."""
    selected = set(select_suites(paths))
    if selected or "requirements-dev.txt" in paths:
        selected.add("standards")
    return sorted(selected)


def changed_paths(base, root=ROOT):
    if not base or not re.fullmatch(r"[0-9a-f]{40}", base) or base == "0" * 40:
        return None
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "-z", base, "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
        )
        return [p for p in result.stdout.decode("utf-8").split("\0") if p]
    except (subprocess.CalledProcessError, UnicodeError):
        return None


def imported(file, found):
    """The file and every file it reaches through relative imports."""
    found.add(file)
    for target in re.findall(
        r"""(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]""", file.read_text("utf-8")
    ):
        path = (file.parent / target).resolve()
        if path.is_file() and path not in found:
            imported(path, found)
    return found


def typescript_tests(paths, root=ROOT):
    """The test files that import a changed file; all of them when that cannot be told."""
    files = sorted(root.glob("tests/**/*.test.ts"))
    every = [file.relative_to(root).as_posix() for file in files]
    if paths is None:
        return every
    uses = {
        name: imported(file, set()) for name, file in zip(every, files, strict=True)
    }
    # These read sources instead of importing them: the repository checks, and the
    # test that keeps Study from writing, holding credentials or dispatching.
    chosen = {name for name in every if name.startswith("tests/repository/")}
    if any(path.startswith("services/study/") for path in paths):
        chosen.add("tests/study/read-only.test.ts")
    for path in paths:
        if "typescript" not in select_suites([path]):
            continue
        users = {name for name, used in uses.items() if root / path in used}
        # Tests read data files instead of importing them, so only code narrows.
        if not users or not path.endswith((".ts", ".mjs")):
            return every
        chosen |= users
    return sorted(chosen)


def standard_tools_changed(paths):
    return paths is None or any(path.startswith(STANDARD_TOOLS) for path in paths)


def run(profile):
    paths = None
    if profile in ("typescript", "standards"):
        paths = changed_paths(os.environ.get("CHECK_BASE"))
    tests = typescript_tests(paths) if profile == "typescript" else []
    commands = {
        "typescript": [
            ["npm", "run", "typecheck"],
            ["node", "tools/check-boundaries.mjs"],
            ["node", "--test", *tests],
            ["npm", "run", "build"],
            ["npm", "run", "check:platform"],
        ],
        "python": [
            ["node", "tools/run-python.mjs", mode]
            for mode in ("boundaries", "import", "test")
        ],
        "repository": [
            [
                sys.executable,
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests/repository",
                "-p",
                "test_*.py",
                "-v",
            ]
        ],
        "standards": [["npm", "run", "check:standards"]]
        + [["npm", "run", "test:standards"]] * standard_tools_changed(paths),
    }
    if profile not in commands:
        raise ValueError("Unknown check profile")
    environment = None
    if profile == "repository":
        # The deployment and provisioning scripts under test import the shared Python package.
        shared = str(ROOT / "packages/shared-python/src")
        environment = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                filter(None, [shared, os.environ.get("PYTHONPATH")])
            ),
        }
    for command in commands[profile]:
        subprocess.run(command, cwd=ROOT, check=True, env=environment)


def run_together(selected):
    """Run the profiles at the same time and show each one's output in one piece."""

    def captured(profile):
        return subprocess.run(
            [sys.executable, __file__, profile],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    with ThreadPoolExecutor() as pool:
        results = dict(zip(selected, pool.map(captured, selected), strict=True))
    failed = [name for name, result in results.items() if result.returncode]
    # Failed output comes last and unfolded.
    for name in sorted(results, key=lambda name: name in failed):
        print(f"{name} failed" if name in failed else f"::group::{name}", flush=True)
        sys.stdout.buffer.write(results[name].stdout)
        print("" if name in failed else "::endgroup::", flush=True)
    if failed:
        raise SystemExit(f"Failed checks: {', '.join(failed)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", choices=(*PROFILES, "route", "selected"))
    args = parser.parse_args()
    if args.profile in PROFILES:
        run(args.profile)
        return
    paths = changed_paths(os.environ.get("CHECK_BASE"))
    selected = PROFILES if paths is None else select_profiles(paths)
    if args.profile == "selected":
        run_together(selected)
        return
    # Fixed booleans only: paths and PR-supplied text never become workflow commands.
    output = (
        "\n".join(f"{p}={'true' if p in selected else 'false'}" for p in PROFILES)
        + "\n"
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            stream.write(output)
    else:
        print(json.dumps(list(selected)))


if __name__ == "__main__":
    main()

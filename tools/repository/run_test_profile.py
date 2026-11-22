"""Credential-free check profiles and conservative changed-path routing."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PROFILES = ("typescript", "python", "repository", "standards")


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
        if path.startswith(("schemas/", "tests/conformance/")):
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


def run(profile):
    commands = {
        "typescript": [
            ["npm", "run", "typecheck"],
            ["node", "tools/check-boundaries.mjs"],
            ["npm", "run", "test:typescript"],
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
        "standards": [
            ["npm", "run", "check:standards"],
            ["npm", "run", "test:standards"],
        ],
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", choices=(*PROFILES, "route"))
    args = parser.parse_args()
    if args.profile != "route":
        run(args.profile)
        return
    paths = changed_paths(os.environ.get("CHECK_BASE"))
    selected = PROFILES if paths is None else select_profiles(paths)
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

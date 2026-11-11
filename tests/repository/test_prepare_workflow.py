"""GH-04: static properties of the protected preparation workflow (no Actions run needed)."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/prepare.yml").read_text(encoding="utf-8")
RUN_JOBS = ("acquire", "prepare", "quality")
SECRETS = ("CONTROL_ORIGIN", "PREPARATION_ACCESS_CLIENT_ID", "PREPARATION_ACCESS_CLIENT_SECRET",
           "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "R2_BUCKET", "PREPARATION_CLOUDFLARE_TOKEN")


def job_block(name):
    match = re.search(rf"(?ms)^  {name}:\n(.*?)(?=^  [a-z]+:\n|\Z)", WORKFLOW)
    assert match, name
    return match.group(1)


class PrepareWorkflowTests(unittest.TestCase):
    def test_manual_dispatch_on_trusted_main_only(self):
        self.assertIn("workflow_dispatch:", WORKFLOW)
        for denied in ("pull_request", "push:", "schedule:", "workflow_run", "workflow_call", "repository_dispatch"):
            self.assertNotIn(denied, WORKFLOW)
        for name in ("validate", *RUN_JOBS):
            self.assertIn("if: github.ref == 'refs/heads/main'", job_block(name))

    def test_job_input_never_reaches_environment_or_shell(self):
        # Step environments are printed in public logs; the runner reads the event file instead.
        self.assertNotRegex(WORKFLOW, r"inputs\.job|github\.event\.inputs|toJSON\(")
        # The only input expression is the run title: the job's SHA-256, never the job itself.
        self.assertEqual(re.findall(r"\$\{\{[^}]*inputs[^}]*\}\}", WORKFLOW), ["${{ inputs.dispatch_ref }}"])
        self.assertIn("\nrun-name: Preparation ${{ inputs.dispatch_ref }}\n", WORKFLOW)
        self.assertNotIn("set -x", WORKFLOW)
        self.assertNotIn("ACTIONS_STEP_DEBUG", WORKFLOW)

    def test_least_privilege_and_separate_environment(self):
        self.assertRegex(WORKFLOW, r"(?m)^permissions:\n  contents: read\n")
        for denied in ("contents: write", "id-token:", "actions: write", "upload-artifact", "download-artifact",
                       "actions/cache", "wrangler", "terraform", "DEPLOYMENT_", "PLATFORM_STATE"):
            self.assertNotIn(denied, WORKFLOW)
        validate = job_block("validate")
        self.assertNotIn("environment:", validate)
        self.assertNotIn("secrets.", validate)
        for name in RUN_JOBS:
            block = job_block(name)
            self.assertIn("environment: preparation", block)
            self.assertIn("needs: validate", block)
            self.assertIn(f"needs.validate.outputs.kind == '{name}'", block)
            self.assertIn(f"--kind {name} ", block)
            for secret in SECRETS:
                # Configuration is masked as secrets so identifiers stay out of public logs.
                self.assertIn(f"{secret}: ${{{{ secrets.{secret} }}}}", block)
            self.assertNotRegex(block, r"\$\{\{\s*vars\.")

    def test_runner_output_captured_and_only_fixed_status_published(self):
        for name in RUN_JOBS:
            block = job_block(name)
            self.assertIn('> "$RUNNER_TEMP/preparation-private.log" 2>&1', block)
            self.assertIn('rm -f -- "$RUNNER_TEMP/preparation-private.log"', block)
            self.assertIn('cat "$status" >> "$GITHUB_STEP_SUMMARY"', block)
            self.assertIn("umask 077", block)
        self.assertIn("--validate --status", job_block("validate"))
        self.assertIn("> /dev/null 2>&1", job_block("validate"))

    def test_actions_pinned_and_credentials_not_persisted(self):
        uses = [line for line in WORKFLOW.splitlines() if "uses:" in line]
        self.assertTrue(uses)
        for line in uses:
            self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")
        self.assertEqual(WORKFLOW.count("persist-credentials: false"), WORKFLOW.count("actions/checkout@"))
        self.assertEqual(WORKFLOW.count("python-version-file: .python-version"), 4)


def run_script(name):
    """The job's single `run: |` block, exactly as written in the workflow."""
    block = job_block(name)
    match = re.search(r"(?ms)^        run: \|\n(.*?)(?=^      - |\Z)", block)
    assert match, name
    return textwrap.dedent(match.group(1))


class FailurePathTests(unittest.TestCase):
    """Run each step script as GitHub does (bash -e -o pipefail) with a stand-in runner."""

    def run_step(self, name, exit_code, write_status=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir, temp = root / "bin", root / "runner-temp"
            bin_dir.mkdir()
            temp.mkdir()
            summary = root / "summary.md"
            # Stand-in python3: writes the fixed status line, leaks text to stdout/stderr, then exits.
            fake = bin_dir / "python3"
            fake.write_text(textwrap.dedent(f"""\
                #!/bin/bash
                status=""
                while [[ $# -gt 0 ]]; do [[ "$1" == --status ]] && status="$2"; shift; done
                {'echo "Preparation unit finished: failed." > "$status"' if write_status else ''}
                echo "PRIVATE-MARKER stdout"; echo "PRIVATE-MARKER stderr" >&2
                exit {exit_code}
                """))
            fake.chmod(0o755)
            script = root / "step.sh"
            script.write_text(run_script(name))
            env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "RUNNER_TEMP": str(temp),
                   "GITHUB_STEP_SUMMARY": str(summary)}
            completed = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
                                       env=env, capture_output=True, text=True, timeout=30)
            leftover = sorted(p.name for p in temp.iterdir())
            summary_text = summary.read_text() if summary.exists() else ""
            return completed, leftover, summary_text

    def test_failed_runner_still_publishes_status_and_removes_private_log(self):
        for name in RUN_JOBS:
            completed, leftover, summary = self.run_step(name, 1)
            self.assertEqual(completed.returncode, 1, name)
            self.assertEqual(completed.stdout, "Preparation unit finished: failed.\n")
            self.assertEqual(summary, "Preparation unit finished: failed.\n")
            self.assertNotIn("PRIVATE-MARKER", completed.stdout + completed.stderr + summary)
            self.assertNotIn("preparation-private.log", leftover)

    def test_runner_without_status_reports_fixed_line(self):
        for name in RUN_JOBS:
            completed, leftover, _ = self.run_step(name, 3, write_status=False)
            self.assertEqual(completed.returncode, 3)
            self.assertIn("Control reconciles this run.", completed.stdout)
            self.assertNotIn("preparation-private.log", leftover)

    def test_successful_runner_exits_zero(self):
        completed, leftover, _ = self.run_step("prepare", 0)
        self.assertEqual(completed.returncode, 0)
        self.assertNotIn("preparation-private.log", leftover)

    def test_failed_validation_prints_fixed_status(self):
        completed, _, _ = self.run_step("validate", 1)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "Preparation unit finished: failed.\n")
        self.assertNotIn("PRIVATE-MARKER", completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()

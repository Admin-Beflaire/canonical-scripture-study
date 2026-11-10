"""GH-04: static properties of the protected preparation workflow (no Actions run needed)."""
from pathlib import Path
import re
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
        self.assertNotRegex(WORKFLOW, r"\$\{\{[^}]*inputs")
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


if __name__ == "__main__":
    unittest.main()

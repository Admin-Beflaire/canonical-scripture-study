"""Check path routing and the public credential boundary with synthetic inputs."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("profiles", ROOT / "tools/repository/run_test_profile.py")
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)


class RoutingTests(unittest.TestCase):
    def test_shared_contract_changes_run_both_languages(self):
        for path in ("schemas/new.json", "tests/conformance/reference.json"):
            self.assertEqual(profiles.select_profiles([path]), ["python", "typescript"])

    def test_owning_modules_run_only_their_consumer(self):
        for path in ("services/study/src/search.ts", "services/maintenance/control/src/index.ts", "packages/shared/src/index.ts"):
            self.assertEqual(profiles.select_profiles([path]), ["typescript"])
        for path in ("services/maintenance/data-preparation/src/acquire.py", "packages/shared-python/src/css_shared/references.py", "tests/python/test_conformance.py", ".python-version"):
            self.assertEqual(profiles.select_profiles([path]), ["python"])

    def test_workflow_tooling_config_and_unknown_code_fail_closed(self):
        for path in (".github/workflows/checks.yml", "infrastructure/github/main.tf", "tools/build.mjs", "tests/repository/test_ci_routing.py", "future/unknown.py", "package-lock.json"):
            self.assertEqual(set(profiles.select_profiles([path])), set(profiles.PROFILES))

    def test_docs_only_change_keeps_gate_without_running_suites(self):
        self.assertEqual(profiles.select_profiles(["README.md", "CONTRIBUTING.md"]), [])

    def test_removed_and_renamed_inputs_are_routed_as_paths(self):
        self.assertEqual(profiles.select_profiles(["packages/shared/old.ts", "packages/shared-python/new.py"]), ["python", "typescript"])

    def test_public_workflow_cannot_access_privileged_inputs(self):
        workflow = (ROOT / ".github/workflows/checks.yml").read_text()
        for denied in ("pull_request_target", "workflow_run", "secrets.", "environment:", "id-token:", "contents: write", "upload-artifact", "actions/cache"):
            self.assertNotIn(denied, workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+cache:")
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("package-manager-cache: false", workflow)
        self.assertIn("npm ci --ignore-scripts", workflow)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")
        self.assertIn("pull_request:", workflow)
        self.assertNotIn("paths:", workflow)  # Required gate always completes, even on docs-only PRs.

    def test_profile_names_are_not_executable_input(self):
        with self.assertRaises(ValueError):
            profiles.run("python; echo forbidden")
        self.assertIsNone(profiles.changed_paths("HEAD; echo forbidden"))
        self.assertIsNone(profiles.changed_paths("0" * 40))


if __name__ == "__main__":
    unittest.main()

"""Check path routing and the public credential boundary with synthetic inputs."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "profiles", ROOT / "tools/repository/run_test_profile.py"
)
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)


class RoutingTests(unittest.TestCase):
    def test_wrong_language_files_run_both_boundary_checkers(self):
        typescript_homes = (
            "services/study/",
            "services/maintenance/control/",
            "packages/shared/",
            "tests/shared/",
            "tests/study/",
        )
        python_homes = (
            "services/maintenance/data-preparation/",
            "packages/shared-python/",
            "tests/python/",
        )
        for path in [home + "misplaced.py" for home in typescript_homes] + [
            home + "misplaced" + suffix
            for home in python_homes
            for suffix in (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
        ]:
            with self.subTest(path=path):
                self.assertEqual(
                    set(profiles.select_profiles([path])), set(profiles.PROFILES)
                )

    def test_repository_profile_reuses_selected_python_interpreter(self):
        with (
            patch.object(profiles.sys, "executable", "selected-python"),
            patch.object(profiles.subprocess, "run") as execute,
        ):
            profiles.run("repository")
        self.assertEqual(execute.call_args.args[0][0], "selected-python")

    def test_repository_profile_can_import_the_shared_python_package(self):
        with patch.object(profiles.subprocess, "run") as execute:
            profiles.run("repository")
        shared = str(profiles.ROOT / "packages/shared-python/src")
        paths = execute.call_args.kwargs["env"]["PYTHONPATH"].split(profiles.os.pathsep)
        self.assertEqual(paths[0], shared)

    def test_shared_contract_changes_run_both_languages(self):
        for path in ("schemas/new.json", "tests/conformance/reference.json"):
            self.assertEqual(
                profiles.select_profiles([path]), ["python", "standards", "typescript"]
            )

    def test_owning_modules_run_only_their_consumer(self):
        for path in (
            "services/study/src/search.ts",
            "services/maintenance/control/src/index.ts",
            "packages/shared/src/index.ts",
            "tests/study/search.test.ts",
        ):
            self.assertEqual(
                profiles.select_profiles([path]), ["standards", "typescript"]
            )
        for path in (
            "services/maintenance/data-preparation/src/acquire.py",
            "tests/python/test_conformance.py",
            ".python-version",
        ):
            self.assertEqual(profiles.select_profiles([path]), ["python", "standards"])

    def test_shared_python_changes_also_run_the_scripts_that_import_it(self):
        self.assertEqual(
            profiles.select_profiles(
                ["packages/shared-python/src/css_shared/error_record.py"]
            ),
            ["python", "repository", "standards"],
        )

    def test_workflow_tooling_config_and_unknown_code_fail_closed(self):
        for path in (
            ".github/workflows/checks.yml",
            "infrastructure/github/main.tf",
            "tools/build.mjs",
            "tests/repository/test_ci_routing.py",
            "future/unknown.py",
            "package-lock.json",
            "tests/platform/platform.test.ts",
            "infrastructure/cloudflare/render.mjs",
            "infrastructure/github/deployment/deploy.py",
            "infrastructure/github/deployment/smoke.mjs",
            "infrastructure/github/deployment/compatibility.json",
            "tests/platform/deployment.test.ts",
            ".github/workflows/deploy.yml",
            ".github/workflows/prepare.yml",
        ):
            self.assertEqual(
                set(profiles.select_profiles([path])), set(profiles.PROFILES)
            )

    def test_docs_only_change_keeps_gate_without_running_suites(self):
        self.assertEqual(profiles.select_profiles(["README.md", "CONTRIBUTING.md"]), [])

    def test_removed_and_renamed_inputs_are_routed_as_paths(self):
        self.assertEqual(
            profiles.select_profiles(
                ["packages/shared/old.ts", "packages/shared-python/new.py"]
            ),
            ["python", "repository", "standards", "typescript"],
        )

    def test_typescript_tests_follow_the_imports_of_the_changed_files(self):
        study = profiles.typescript_tests(["services/study/src/index.ts", "README.md"])
        self.assertIn("tests/study/search.test.ts", study)
        self.assertNotIn("tests/maintenance/tasks.test.ts", study)
        control = profiles.typescript_tests(
            ["services/maintenance/control/src/index.ts"]
        )
        self.assertNotIn("tests/study/search.test.ts", control)
        every = profiles.typescript_tests(None)
        # A change that no test imports cannot be narrowed.
        self.assertEqual(profiles.typescript_tests(["schemas/new.json"]), every)

    def test_locked_python_tools_run_only_the_code_standards(self):
        self.assertEqual(
            profiles.select_profiles(["requirements-dev.txt"]), ["standards"]
        )

    def test_code_standards_run_with_every_code_change(self):
        for path in (
            "services/study/src/search.ts",
            "tests/python/test_conformance.py",
            "ruff.toml",
            "eslint.config.mjs",
            ".prettierignore",
            ".github/workflows/checks.yml",
        ):
            self.assertIn("standards", profiles.select_profiles([path]))

    def test_checker_tests_run_only_when_the_checkers_change(self):
        for changed, commands in (
            (["services/study/src/index.ts"], ["check:standards"]),
            (["eslint.config.mjs"], ["check:standards", "test:standards"]),
        ):
            with (
                patch.object(profiles, "changed_paths", return_value=changed),
                patch.object(profiles.subprocess, "run") as execute,
            ):
                profiles.run("standards")
            self.assertEqual(
                [call.args[0][-1] for call in execute.call_args_list], commands
            )

    def test_public_workflow_cannot_access_privileged_inputs(self):
        workflow = (ROOT / ".github/workflows/checks.yml").read_text()
        for denied in (
            "pull_request_target",
            "workflow_run",
            "secrets.",
            "environment:",
            "id-token:",
            "contents: write",
            "upload-artifact",
            "actions/cache",
        ):
            self.assertNotIn(denied, workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+cache:")
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("package-manager-cache: false", workflow)
        self.assertIn("npm ci --ignore-scripts", workflow)
        self.assertIn("pip install --require-hashes --only-binary=:all:", workflow)
        self.assertIn("run_test_profile.py selected", workflow)
        # The checks need the base commit, as the routing step does.
        base = "CHECK_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}"
        self.assertEqual(workflow.count(base), 2)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")
        self.assertIn("pull_request:", workflow)
        self.assertNotIn(
            "paths:", workflow
        )  # Required gate always completes, even on docs-only PRs.

    def test_profile_names_are_not_executable_input(self):
        with self.assertRaises(ValueError):
            profiles.run("python; echo forbidden")
        self.assertIsNone(profiles.changed_paths("HEAD; echo forbidden"))
        self.assertIsNone(profiles.changed_paths("0" * 40))


if __name__ == "__main__":
    unittest.main()

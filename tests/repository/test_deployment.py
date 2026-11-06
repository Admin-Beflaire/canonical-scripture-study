"""Synthetic deployment ordering, compatibility, credentials and failure checks."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("deployment", ROOT / "infrastructure/github/deployment/deploy.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DeploymentTests(unittest.TestCase):
    def test_incompatible_unknown_and_empty_versions_rejected(self):
        supported = {"evidence_records": ["1"], "native_reference": ["1"]}
        d.compatible({"evidence_records": "1", "native_reference": "1"}, supported)
        for versions in ({}, [], {"evidence_records": "2"}, {"new_contract": "1"}):
            with self.assertRaises(d.DeploymentError):
                d.compatible(versions, supported)

    def test_selection_initial_existing_and_incompatible_revert(self):
        self.assertIsNone(d.selection(lambda sql: [], {}))
        responses = iter([[{"name": "release_selection"}], [{"current_release_id": "r1", "schema_versions_json": '{"evidence_records":"1"}'}]])
        self.assertEqual(d.selection(lambda sql: next(responses), {"evidence_records": ["1"]}), "r1")
        responses = iter([[{"name": "release_selection"}], [{"current_release_id": "r1", "schema_versions_json": '{"evidence_records":"2"}'}]])
        with self.assertRaises(d.DeploymentError):
            d.selection(lambda sql: next(responses), {"evidence_records": ["1"]})

    def test_subprocess_has_no_shell_and_only_explicit_privileged_credentials(self):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "private-marker", "PLATFORM_STATE_TOKEN": "private-marker", "DEPLOYMENT_SMOKE_JWT": "private-marker"}):
            with patch.object(d.subprocess, "run") as execute:
                execute.return_value.returncode = 0
                d.run(["node", "build"], io.StringIO())
                self.assertNotIn("shell", execute.call_args.kwargs)
                self.assertNotIn("CLOUDFLARE_API_TOKEN", execute.call_args.kwargs["env"])
                self.assertNotIn("PLATFORM_STATE_TOKEN", execute.call_args.kwargs["env"])
                d.run(["wrangler"], io.StringIO(), {"CLOUDFLARE_API_TOKEN": "scoped"})
                self.assertEqual(execute.call_args.kwargs["env"]["CLOUDFLARE_API_TOKEN"], "scoped")
                execute.return_value.returncode = 1
                with self.assertRaisesRegex(d.DeploymentError, "phase failed"):
                    d.run(["failed"], io.StringIO())

    def fixture(self, directory):
        root = Path(directory)
        config = {"account_id": "a" * 32, "name": "css-study-test", "d1_databases": [{"database_id": "database"}], "r2_buckets": [{"bucket_name": "bucket"}], "vars": {"HOSTNAME": "study.example.invalid", "ENHANCEMENTS": False}}
        (root / "dist/config").mkdir(parents=True)
        (root / "dist/config/study.json").write_text(json.dumps(config))
        (root / "infrastructure/github/deployment").mkdir(parents=True)
        (root / "infrastructure/github/deployment/compatibility.json").write_text('{"evidence_records":["1"]}')
        (root / "schemas/migrations").mkdir(parents=True)
        (root / "schemas/migrations/0001.sql").write_text("CREATE TABLE fixture(id);")
        return root, config

    def test_binding_identity_and_settings_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, config = self.fixture(tmp)
            settings = {"bindings": [{"name": "DATA_DB", "id": "database"}, {"name": "PRIVATE_OBJECTS", "bucket_name": "bucket"}, {"name": "HOSTNAME", "text": "study.example.invalid"}, {"name": "ENHANCEMENTS", "type": "json", "json": False}]}
            d.check_bindings(settings, config)
            settings["bindings"][0]["id"] = "wrong"
            with self.assertRaises(d.DeploymentError):
                d.check_bindings(settings, config)

    def test_migration_failure_never_deploys_or_writes_success_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = self.fixture(tmp)
            commands = []
            def fail(command, log, env=None):
                commands.append(command)
                raise d.DeploymentError("migration failed")
            with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "secret", "DEPLOYMENT_SMOKE_JWT": "jwt"}), patch.object(d, "selection", return_value=None), patch.object(d, "api", return_value=[{"success": True, "results": []}]), patch.object(d, "run", side_effect=fail):
                with self.assertRaises(d.DeploymentError):
                    d.deploy(root, root, root, "study")
            self.assertEqual(commands[0][1:4], ["d1", "migrations", "apply"])
            self.assertEqual(len(commands), 1)
            self.assertFalse((root / "receipt.json").exists())

    def test_success_orders_migrations_deploy_readback_smoke_without_selection_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, config = self.fixture(tmp)
            commands, queries = [], []
            def provider(path, token, payload=None):
                if payload:
                    queries.append(payload["sql"])
                    return [{"success": True, "results": []}]
                if path.endswith("/subdomain"):
                    return {"enabled": False, "previews_enabled": False}
                return {"bindings": []}
            env = {"CLOUDFLARE_API_TOKEN": "secret", "DEPLOYMENT_SMOKE_JWT": "jwt", "SELECTED_SHA": "a"*40, "ATTEMPT_ID": "1-1"}
            with patch.dict(os.environ, env), patch.object(d, "selection", return_value="r1"), patch.object(d, "api", side_effect=provider), patch.object(d, "check_bindings"), patch.object(d, "run", side_effect=lambda command, log, env=None: commands.append(command)):
                d.deploy(root, root, root, "study")
            self.assertEqual(commands[0][1:4], ["d1", "migrations", "apply"])
            self.assertEqual(commands[1][1], "deploy")
            self.assertEqual(commands[2][0], "node")
            self.assertTrue(all(sql.startswith("SELECT ") for sql in queries))
            receipt = json.loads((root / "receipt.json").read_text())
            self.assertEqual(receipt["selected_data"], "r1")
            self.assertEqual(receipt["host_observations"], "not_performed")
            self.assertNotIn("secret", (root / "receipt.json").read_text())

    def test_workflow_manual_main_only_step_scoped_and_no_artifact_reuse(self):
        workflow = (ROOT / ".github/workflows/deploy.yml").read_text()
        for required in ("workflow_dispatch:", "github.ref == 'refs/heads/main'", "environment: deployment", "persist-credentials: false", "git merge-base --is-ancestor", "npm ci --ignore-scripts", 'npm run "build:$TARGET"', '"$APPROVAL" == DEPLOY', "if: always()", "cancel-in-progress: false"):
            self.assertIn(required, workflow)
        for denied in ("pull_request:", "pull_request_target:", "workflow_run:", "upload-artifact", "download-artifact", "actions/cache", "contents: write"):
            self.assertNotIn(denied, workflow)
        build = workflow.split("      - name: Build selected", 1)[1].split("      - name: Render", 1)[0]
        self.assertNotIn("secrets.", build)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")


if __name__ == "__main__":
    unittest.main()

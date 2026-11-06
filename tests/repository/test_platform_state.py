"""Credential-free GH-02 state protocol and workflow tests."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("platform_state", ROOT / "infrastructure/github/platform_state.py")
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class FakePrivateRelease:
    def __init__(self):
        self.release = None
        self.items = []
        self.next_id = 1

    def request(self, method, path, data=None, binary=False, upload=False):
        if "/releases/tags/" in path:
            return self.release
        if method == "POST" and path.endswith("/releases"):
            self.release = {"id": 1}
            return self.release
        if method == "GET" and "/assets?" in path:
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(path).query)
            page = int(query.get("page", ["1"])[0])
            size = int(query.get("per_page", ["100"])[0])
            return self.items[(page - 1) * size:page * size]
        if method == "POST" and upload:
            from urllib.parse import parse_qs, urlparse
            name = parse_qs(urlparse(path).query)["name"][0]
            obj = {"name": name, "id": self.next_id, "payload": data}
            self.next_id += 1
            self.items.append(obj)
            return obj
        if method == "GET" and "/releases/assets/" in path:
            ident = int(path.rsplit("/", 1)[1])
            return next(x["payload"] for x in self.items if x["id"] == ident)
        raise AssertionError((method, path))


class StateTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakePrivateRelease()
        p = patch.object(state, "request", side_effect=self.fake.request)
        p.start()
        self.addCleanup(p.stop)

    def test_missing_state_requires_explicit_approval_for_both_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            for key in ("github", "cloudflare"):
                output = Path(tmp) / key
                with self.assertRaises(state.StateError):
                    state.restore(key, output)
                self.assertEqual(state.restore(key, output, True), "empty")
                self.assertFalse(output.exists())

    def test_checked_state_round_trip_and_separate_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "state"
            p.write_bytes(b'{"version":4,"serial":1}')
            state.begin("github", "123-1")
            state.finish("github", "123-1", p, True)
            output = Path(tmp) / "restored"
            self.assertEqual(state.restore("github", output), "verified")
            self.assertEqual(output.read_bytes(), p.read_bytes())
            with self.assertRaises(state.StateError):
                state.restore("cloudflare", output)
            self.assertEqual(state.restore("cloudflare", output, True), "empty")

    def test_uncertain_apply_keeps_state_and_blocks_next_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "state"
            p.write_bytes(b'{"version":4}')
            state.begin("github", "200-1")
            with self.assertRaises(state.StateError):
                state.finish("github", "200-1", p, False)
            self.assertTrue(any(x["name"].endswith("receipt.json") for x in self.fake.items))
            with self.assertRaises(state.StateError):
                state.begin("github", "201-1")
            with self.assertRaises(state.StateError):
                state.restore("github", Path(tmp) / "out", True)

    def test_interrupted_begin_with_no_state_blocks_reuse(self):
        state.begin("cloudflare", "300-1")
        with self.assertRaisesRegex(state.StateError, "Interrupted"):
            state.begin("cloudflare", "301-1")
        with self.assertRaises(state.StateError):
            state.restore("cloudflare", "/unused", True)

    def test_corrupt_snapshot_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "state"
            p.write_bytes(b'{"version":4}')
            state.begin("cloudflare", "400-1")
            state.finish("cloudflare", "400-1", p, True)
            self.fake.items[-2]["payload"] = b"changed"
            with self.assertRaises(state.StateError):
                state.restore("cloudflare", Path(tmp) / "out")

    def test_stale_run_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "state"
            p.write_bytes(b'{"version":4}')
            state.begin("github", "500-1")
            state.finish("github", "500-1", p, True)
            for run in ("499-2", "500-1"):
                with self.assertRaisesRegex(state.StateError, "Stale"):
                    state.begin("github", run)

    def test_capacity_allows_996_assets_but_rejects_997(self):
        self.fake.release = {"id": 1}
        self.fake.items = [
            {"name": "other--dummy-" + str(i), "id": 10000 + i, "payload": b""}
            for i in range(996)
        ]
        state.begin("github", "501-1")
        self.assertEqual(self.fake.items[-1]["name"], "github--501-1--begin.json")
        with self.assertRaisesRegex(state.StateError, "capacity exhausted"):
            state.begin("cloudflare", "502-1")

    def test_private_diagnostics_are_one_verified_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "diagnostics"
            path.write_bytes(b"plan or apply details: private")
            state.diagnostic("github", "600-1", path)
            self.assertEqual(len(self.fake.items), 1)
            self.assertEqual(self.fake.items[0]["name"], "log--github--600-1--diagnostics.txt")
            self.assertEqual(self.fake.items[0]["payload"], path.read_bytes())
            with self.assertRaisesRegex(state.StateError, "Duplicate"):
                state.diagnostic("github", "600-1", path)

    def test_diagnostics_upload_readback_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "diagnostics"
            path.write_bytes(b"private")
            original = self.fake.request
            def tampered(method, name, data=None, binary=False, upload=False):
                result = original(method, name, data, binary, upload)
                if binary:
                    return b"tampered"
                return result
            with patch.object(state, "request", side_effect=tampered):
                with self.assertRaisesRegex(state.StateError, "verification failed"):
                    state.diagnostic("github", "601-1", path)

    def test_existing_legacy_assets_untouched_by_explicit_empty_start(self):
        self.fake.release = {"id": 1}
        self.fake.items = [
            {"name": "github-state-old.age", "id": 1, "payload": b"legacy"},
            {"name": "attempt-123", "id": 2, "payload": b"legacy"},
            {"name": "complete-123", "id": 3, "payload": b"legacy"},
        ]
        self.assertEqual(state.restore("github", "/unused", True), "empty")
        state.begin("github", "700-1")
        self.assertEqual(len(self.fake.items), 4)
        self.assertEqual(self.fake.items[0]["payload"], b"legacy")

    def test_unknown_asset_in_new_protocol_blocks(self):
        state.begin("cloudflare", "800-1")
        self.fake.items.append({"name": "cloudflare--legacy.tfstate", "id": 50, "payload": b"old"})
        with self.assertRaises(state.StateError):
            state.restore("cloudflare", "/unused", True)

    def test_non_dictionary_and_corrupted_receipts_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "state"
            p.write_bytes(b'{"version":4}')
            state.begin("github", "810-1")
            state.finish("github", "810-1", p, True)
            for content in (b'[]', b'invalid-json'):
                self.fake.items[-1]["payload"] = content
                with self.assertRaises((state.StateError, ValueError)):
                    state.restore("github", Path(tmp) / "out")

    def test_invalid_run_ids_and_duplicate_runs(self):
        with self.assertRaises(state.StateError):
            state.begin("github", "../../bad")
        state.begin("cloudflare", "820-1")
        with self.assertRaises(state.StateError):
            state.begin("cloudflare", "820-1")

    def test_private_visibility_required(self):
        with patch.object(sys, "argv", ["state.py", "restore",
                                        "--key", "github", "--path", "/unused"]):
            with patch.object(state, "request",
                              return_value={"private": True, "visibility": "internal"}):
                with self.assertRaisesRegex(state.StateError, "not verified private"):
                    state.main()
            with patch.object(state, "request",
                              return_value={"private": True, "visibility": "private"}):
                with patch.object(state, "restore", return_value="verified") as restored:
                    state.main()
                    restored.assert_called_once()

    def test_redirect_strips_cross_host_bearer(self):
        handler = state.SafeRedirectHandler()
        request = urllib.request.Request(
            "https://api.github.com/repos/x/y/releases/assets/1",
            headers={"Authorization": "Bearer private"})
        result = handler.redirect_request(request, None, 302, "Found", {},
                                          "https://release-assets.githubusercontent.com/asset")
        self.assertIsNone(result.get_header("Authorization"))
        same = handler.redirect_request(request, None, 302, "Found", {},
                                        "https://api.github.com/next")
        self.assertEqual(same.get_header("Authorization"), "Bearer private")
        with self.assertRaises(state.StateError):
            handler.redirect_request(request, None, 302, "Found", {},
                                     "http://release-assets.githubusercontent.com/file")


class WorkflowTests(unittest.TestCase):
    def test_minimal_manual_trusted_workflow_with_step_scoped_secrets(self):
        workflow = (ROOT / ".github/workflows/platform.yml").read_text()
        for item in ("workflow_dispatch:", "group: platform-state",
                     "cancel-in-progress: false", "environment: provisioning",
                     "git merge-base --is-ancestor", "git checkout --detach",
                     "persist-credentials: false", "initialize_empty_state:",
                     "terraform init -input=false", "terraform plan -input=false",
                     "terraform apply -input=false", "begin --key", "finish --key",
                     "diagnostic --key", "if: always()"):
            self.assertIn(item, workflow)
        for removed in ("docker run", "terraform_isolated.sh", "plan-save", "plan-fetch",
                        "plan_run:", "plan_sha256:", "rescue --key", "-backend=false",
                        "upload-artifact", "pull_request:", "pull_request_target:",
                        "workflow_run:"):
            self.assertNotIn(removed, workflow)
        header = workflow.split("    steps:", 1)[0]
        for secret in ("PLATFORM_GITHUB_TOKEN", "PLATFORM_CLOUDFLARE_TOKEN",
                       "PLATFORM_GITHUB_TFVARS_JSON", "PLATFORM_CLOUDFLARE_TFVARS_JSON",
                       "PLATFORM_STATE_TOKEN"):
            self.assertNotIn(secret, header)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\\w/-]+@[0-9a-f]{40}(?: |$)")


if __name__ == "__main__":
    unittest.main()

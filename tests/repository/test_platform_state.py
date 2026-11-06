"""Credential-free GH-02 protocol and workflow boundary tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
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
            return self.items[:]
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
        self.patch = patch.object(state, "request", side_effect=self.fake.request)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_missing_state_blocks_github_and_cloudflare_without_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(state.StateError):
                state.restore("github", str(Path(tmp) / "a"))
            with self.assertRaises(state.StateError):
                state.restore("cloudflare", str(Path(tmp) / "b"))
            self.assertEqual(state.restore("cloudflare", str(Path(tmp) / "c"), True), "empty")

    def test_checked_state_round_trip_and_separate_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state"
            path.write_bytes(b'{"version":4,"serial":1}')
            state.begin("cloudflare", "123-1")
            state.finish("cloudflare", "123-1", path, True)
            output = Path(tmp) / "restore"
            self.assertEqual(state.restore("cloudflare", output), "verified")
            self.assertEqual(output.read_bytes(), path.read_bytes())
            with self.assertRaises(state.StateError):
                state.restore("github", output)
            self.assertEqual(state.restore("cloudflare", output), "verified")

    def test_partial_failure_saves_but_blocks_further_actions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state"
            path.write_bytes(b'{"version":4}')
            state.begin("github", "200-1")
            with self.assertRaises(state.StateError):
                state.finish("github", "200-1", path, False)
            self.assertTrue(any(x["name"].endswith("receipt.json") for x in self.fake.items))
            with self.assertRaises(state.StateError):
                state.restore("github", Path(tmp) / "restored")
            with self.assertRaises(state.StateError):
                state.begin("github", "201-1")

    def test_interrupted_begin_blocks_without_fallback(self):
        state.begin("cloudflare", "300-1")
        with self.assertRaises(state.StateError):
            state.begin("cloudflare", "301-1")
        with self.assertRaises(state.StateError):
            state.restore("cloudflare", "/ignored", True)

    def test_corrupt_and_missing_snapshot_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tf"
            p.write_bytes(b'{"version":4}')
            state.begin("cloudflare", "400-1")
            state.finish("cloudflare", "400-1", p, True)
            self.fake.items[-2]["payload"] = b"changed"
            with self.assertRaises(state.StateError):
                state.restore("cloudflare", Path(tmp) / "out")

    def test_duplicate_run_and_wrong_ids_fail_closed(self):
        with self.assertRaises(state.StateError):
            state.begin("cloudflare", "../../bad")
        state.begin("cloudflare", "555-1")
        with self.assertRaises(state.StateError):
            state.begin("cloudflare", "555-1")

    def test_unknown_asset_blocks_legacy_fallback(self):
        state.begin("cloudflare", "888-1")
        self.fake.items.append({"name": "cloudflare--legacy.tfstate", "id": 50, "payload": b"a"})
        with self.assertRaises(state.StateError):
            state.restore("cloudflare", "/ignored")


class WorkflowTests(unittest.TestCase):
    def test_dispatch_never_uses_pr_or_provider_credentials_in_checks(self):
        workflow = (ROOT / ".github/workflows/platform.yml").read_text()
        for text in ("workflow_dispatch:", "group: platform-state", "cancel-in-progress: false",
                     "environment: provisioning", "git merge-base --is-ancestor",
                     "git checkout --detach", "if: github.ref == 'refs/heads/main'",
                     "persist-credentials: false", "steps.begin.outcome == 'success'",
                     "if: always()", "PLATFORM_STATE_TOKEN", "PLATFORM_STATE_REPO"):
            self.assertIn(text, workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertNotIn("pull_request_target:", workflow)
        self.assertNotIn("workflow_run:", workflow)
        self.assertNotIn("upload-artifact", workflow)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")


if __name__ == "__main__":
    unittest.main()

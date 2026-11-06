"""Credential-free GH-02 protocol and workflow boundary tests."""
import importlib.util
import base64
import json
import sys
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
        self.recovery = {}

    def request(self, method, path, data=None, binary=False, upload=False):
        if "/contents/platform-recovery/" in path:
            if method == "GET":
                return {"content": self.recovery[path]} if path in self.recovery else None
            if method == "PUT" and path not in self.recovery:
                self.recovery[path] = json.loads(data)["content"]
                return {"content": {"sha": "mock-sha"}}
            raise AssertionError("Attempted to overwrite private recovery")
        if "/releases/tags/" in path:
            return self.release
        if method == "POST" and path.endswith("/releases"):
            self.release = {"id": 1}
            return self.release
        if method == "GET" and "/assets?" in path:
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(path).query)
            page = int(query.get("page", ["1"])[0])
            page_size = int(query.get("per_page", ["100"])[0])
            return self.items[(page - 1) * page_size:page * page_size]
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

    def test_stale_rerun_and_capacity_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tf"
            p.write_bytes(b'{"version":4}')
            state.begin("github", "500-1")
            state.finish("github", "500-1", p, True)
            with self.assertRaises(state.StateError):
                state.begin("github", "499-2")
            with self.assertRaises(state.StateError):
                state.begin("github", "500-1")
            self.fake.items.extend(
                {"name": "other--dummy-" + str(i), "id": 10000 + i, "payload": b""}
                for i in range(995)
            )
            with self.assertRaisesRegex(state.StateError, "State release capacity exhausted"):
                state.begin("github", "501-1")

    def test_capacity_allows_997_assets(self):
        # A run must have three free slots for its state protocol assets.
        self.fake.items = [
            {"name": "other--dummy-" + str(i), "id": 10000 + i, "payload": b""}
            for i in range(997)
        ]
        self.fake.release = {"id": 1}
        state.begin("github", "501-1")
        self.assertEqual(self.fake.items[-1]["name"], "github--501-1--begin.json")

    def test_private_exact_plan_round_trip_and_approval_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / "terraform.tfstate"
            state_file.write_bytes(b'{"version":4,"serial":1}')
            state.begin("github", "710-1")
            state.finish("github", "710-1", state_file, True)
            plan = Path(tmp) / "plan.tfplan"
            review = Path(tmp) / "review.txt"
            output = Path(tmp) / "approved.tfplan"
            plan.write_bytes(b"exact synthetic binary plan")
            review.write_text("Synthetic readable Terraform changes")
            approved = state.digest(plan.read_bytes())
            state.plan_save("github", "711-1", "a" * 40, plan, review)
            state.plan_fetch("github", "711-1", "a" * 40, approved, output)
            self.assertEqual(output.read_bytes(), plan.read_bytes())
            with self.assertRaises(state.StateError):
                state.plan_fetch("github", "711-1", "a" * 40, "b" * 64, output)
            with self.assertRaises(state.StateError):
                state.plan_fetch("github", "711-1", "b" * 40, approved, output)
            state_file.write_bytes(b'{"version":4,"serial":2}')
            state.begin("github", "712-1")
            state.finish("github", "712-1", state_file, True)
            with self.assertRaises(state.StateError):
                state.plan_fetch("github", "711-1", "a" * 40, approved, output)

    def test_incomplete_private_plan_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / "plan"
            review = Path(tmp) / "review"
            plan.write_bytes(b"plan")
            review.write_bytes(b"review")
            state.plan_save("cloudflare", "801-1", "a" * 40, plan, review, True)
            self.fake.items.pop()
            with self.assertRaisesRegex(state.StateError, "Incomplete private plan"):
                state.plan_fetch("cloudflare", "801-1", "a" * 40,
                                 state.digest(plan.read_bytes()), Path(tmp) / "out", True)

    def test_private_recovery_fallback_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / "terraform.tfstate"
            state_file.write_bytes(b'{"version":4,"serial":42}')
            state.rescue("github", "901-1", state_file)
            self.assertEqual(len(self.fake.recovery), 1)
            self.assertEqual(base64.b64decode(next(iter(self.fake.recovery.values()))),
                             state_file.read_bytes())
            with self.assertRaisesRegex(state.StateError, "already exists"):
                state.rescue("github", "901-1", state_file)

    def test_internal_repository_not_accepted_as_private(self):
        with patch.object(sys, "argv", ["platform_state.py", "restore",
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

    def test_non_dictionary_receipt_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tf"
            p.write_bytes(b'{"version":4}')
            state.begin("github", "600-1")
            state.finish("github", "600-1", p, True)
            self.fake.items[-1]["payload"] = b'[]'
            with self.assertRaises(state.StateError):
                state.restore("github", Path(tmp) / "restore")

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
        self.assertIn("--cap-drop ALL", workflow)
        self.assertIn("plan-save --key", workflow)
        self.assertIn("plan-fetch --key", workflow)
        self.assertIn('plan_sha256:', workflow)
        self.assertIn("steps.finish.outcome != 'success'", workflow)
        self.assertIn('rescue --key "$TARGET"', workflow)
        self.assertIn("steps.apply_plan.outcome == 'success'", workflow)
        self.assertNotIn("--env PLATFORM_STATE_TOKEN", workflow)
        for line in workflow.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: [\w/-]+@[0-9a-f]{40}(?: |$)")


if __name__ == "__main__":
    unittest.main()

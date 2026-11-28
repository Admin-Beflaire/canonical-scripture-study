import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from css_shared import tool_log

PLAN = """Terraform will perform the following actions:

  # cloudflare_workers_kv_namespace.verified_word_cache will be updated in-place
  ~ resource "cloudflare_workers_kv_namespace" "verified_word_cache" {
        id    = "8071e577bb1a49ddb0aad5d3f230bc31"
      ~ title = "private-title" -> "other-private-title"
    }

  # cloudflare_d1_database.data["a b"] must be replaced
-/+ resource "cloudflare_d1_database" "data" {
      ~ name = "x" -> (known after apply)
      + policy = <<-EOT
            + sneaky = value
        EOT
    }

  # cloudflare_dns_record.old will be destroyed
  - resource "cloudflare_dns_record" "old" {
      - content = "203.0.113.9" -> null
    }

Plan: 1 to add, 1 to change, 2 to destroy.
"""

FAILURE = """╷
│ Error: failed to create Workers KV namespace
│
│   with cloudflare_workers_kv_namespace.verified_word_cache,
│   on main.tf line 12, in resource "cloudflare_workers_kv_namespace" "verified_word_cache":
╵
╷
│ Error: Authentication error 0123456789abcdef0123456789abcdef0123
╵
"""

WRANGLER = """✘ [ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/d1) failed.

  Authentication error [code: 10000]
"""


def run_tool(*args, text=""):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "output.log"
        path.write_text(text)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = tool_log.main([*args, "--log", str(path)])
    lines = out.getvalue().splitlines()
    return status, lines


def parsed(line):
    return json.loads(line.split("::", 2)[2].replace("%25", "%"))


class PlanRecordTests(unittest.TestCase):
    def test_plan_gives_totals_and_each_resource_with_attribute_names(self):
        status, lines = run_tool(
            "terraform",
            "--tool",
            "platform",
            "--stage",
            "plan",
            "--id",
            "target=cloudflare",
            text=PLAN,
        )
        records = [parsed(line) for line in lines]
        self.assertEqual(status, 0)
        self.assertTrue(
            all(line.startswith("::notice title=platform plan::") for line in lines)
        )
        self.assertEqual(
            records[0]["counts"], {"add": 1, "change": 1, "destroy": 2, "resources": 3}
        )
        found = {
            (r["ids"]["resource"], r["ids"]["action"]): r["names"] for r in records[1:]
        }
        self.assertEqual(
            found,
            {
                ("cloudflare_workers_kv_namespace.verified_word_cache", "update"): [
                    "title"
                ],
                ("cloudflare_d1_database.data", "replace"): ["name", "policy"],
                ("cloudflare_dns_record.old", "destroy"): ["content"],
            },
        )

    def test_no_value_from_the_plan_reaches_the_output(self):
        _, lines = run_tool(
            "terraform", "--tool", "platform", "--stage", "plan", text=PLAN
        )
        output = "\n".join(lines)
        for private in (
            "private-title",
            "8071e577",
            "203.0.113.9",
            "sneaky",
            "a b",
            "known after apply",
        ):
            self.assertNotIn(private, output)


class FailureRecordTests(unittest.TestCase):
    def test_terraform_failure_gives_kind_address_and_exit(self):
        _, lines = run_tool(
            "terraform",
            "--tool",
            "platform",
            "--stage",
            "apply",
            "--exit",
            "1",
            "--id",
            "run=5-1",
            text=FAILURE,
        )
        first, second = (parsed(line) for line in lines)
        self.assertTrue(lines[0].startswith("::error title=platform apply::"))
        self.assertEqual(first["code"], "terraform_failed")
        self.assertEqual(first["exit"], 1)
        self.assertEqual(first["message"], "The provider could not create a resource.")
        self.assertNotIn("Workers KV", lines[0])
        self.assertEqual(
            first["ids"]["resource"],
            "cloudflare_workers_kv_namespace.verified_word_cache",
        )
        self.assertEqual(
            second["message"], "The provider refused the credentials or the permission."
        )
        self.assertNotIn("0123456789abcdef", lines[1])

    def test_a_short_value_in_the_tool_summary_is_never_printed(self):
        for text in (
            "Error: invalid value secret123\n",
            "Error: could not create hunter2\n",
            "Error: something about hunter2\n",
        ):
            with self.subTest(text=text):
                _, lines = run_tool(
                    "terraform",
                    "--tool",
                    "platform",
                    "--stage",
                    "apply",
                    "--exit",
                    "1",
                    text=text,
                )
                self.assertEqual(len(lines), 1)
                self.assertNotIn("secret123", lines[0])
                self.assertNotIn("hunter2", lines[0])

    def test_wrangler_failure_keeps_the_provider_code_not_the_message(self):
        _, lines = run_tool(
            "wrangler",
            "--tool",
            "deploy",
            "--stage",
            "deploy",
            "--exit",
            "1",
            text=WRANGLER,
        )
        record = parsed(lines[0])
        self.assertEqual(record["provider_code"], 10000)
        self.assertNotIn("message", record)
        self.assertNotIn("0123456789abcdef", lines[0])

    def test_the_summary_never_changes_the_exit_status(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = tool_log.main(
                [
                    "terraform",
                    "--tool",
                    "platform",
                    "--stage",
                    "init",
                    "--exit",
                    "1",
                    "--id",
                    "x",
                ],
            )
        self.assertEqual(status, 0)


if __name__ == "__main__":
    unittest.main()

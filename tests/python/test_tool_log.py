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

    def test_a_plan_with_many_resources_is_limited(self):
        text = "".join(
            f'  # aws_thing.t{i} will be created\n  + resource "aws_thing" "t{i}" {{\n'
            f"      + size = 1\n    }}\n"
            for i in range(20)
        )
        _, lines = run_tool(
            "terraform",
            "--tool",
            "platform",
            "--stage",
            "plan",
            text=text + "Plan: 20 to add, 0 to change, 0 to destroy.\n",
        )
        self.assertEqual(len(lines), 1 + tool_log.MAX_RESOURCES)
        self.assertEqual(parsed(lines[0])["counts"]["resources"], 20)

    def test_a_clean_plan_gives_no_records(self):
        _, lines = run_tool(
            "terraform",
            "--tool",
            "platform",
            "--stage",
            "plan",
            text="No changes. Your infrastructure matches the configuration.\n",
        )
        self.assertEqual(lines, [])


class FailureRecordTests(unittest.TestCase):
    def test_terraform_failure_gives_summary_address_and_exit(self):
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
        self.assertEqual(first["message"], "failed to create Workers KV namespace")
        self.assertEqual(
            first["ids"]["resource"],
            "cloudflare_workers_kv_namespace.verified_word_cache",
        )
        # A summary that looks like a key or token is dropped, not stored.
        self.assertNotIn("message", second)

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

    def test_real_wrangler_and_esbuild_output_with_colour_codes(self):
        # Captured from wrangler 4.158.0 and esbuild; Wrangler coloured the output sent to a file.
        wrangler = (
            "\x1b[33m▲ \x1b[43;33m[\x1b[43;30mWARNING\x1b[43;33m]\x1b[0m \x1b[1mProxy environment variables detected.\x1b[0m\n\n"
            "\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m "
            '\x1b[1mThe entry-point file at "missing.js" was not found.\x1b[0m\n\n'
            "  This might mean that your entry-point file needs to be generated.\n"
        )
        esbuild = '✘ [ERROR] Unexpected ";"\n\n    bad.ts:1:10:\n      1 │ const x = ;\n        ╵           ^\n\n1 error\n'
        _, lines = run_tool(
            "wrangler",
            "--tool",
            "deploy",
            "--stage",
            "worker_build",
            "--exit",
            "1",
            text=wrangler,
        )
        self.assertEqual(
            parsed(lines[0])["message"],
            'The entry-point file at "missing.js" was not found.',
        )
        _, lines = run_tool(
            "wrangler",
            "--tool",
            "deploy",
            "--stage",
            "worker_build",
            "--exit",
            "1",
            text=esbuild,
        )
        self.assertEqual(parsed(lines[0])["message"], 'Unexpected ";"')
        self.assertNotIn("const x", lines[0])

    def test_a_command_without_a_known_format_gives_only_its_exit_code(self):
        _, lines = run_tool(
            "none",
            "--tool",
            "deploy",
            "--stage",
            "install",
            "--exit",
            "7",
            text="npm error anything private\n",
        )
        record = parsed(lines[0])
        self.assertEqual(
            (record["code"], record["exit"], record["stage"]),
            ("command_failed", 7, "install"),
        )
        self.assertNotIn("private", lines[0])

    def test_a_missing_log_still_reports_the_failure(self):
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
                    "--log",
                    "/nonexistent/x.log",
                ]
            )
        self.assertEqual(status, 0)
        self.assertEqual(parsed(out.getvalue())["code"], "terraform_failed")

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

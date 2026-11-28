"""GH-04 step 3: runner entry against loopback Cloudflare and Control doubles (synthetic only)."""

import contextlib
import functools
import hashlib
import io
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest import mock

from css_shared.error_record import annotation
from css_preparation.adapters.stepbible.recipes import fetch_recipe
from css_preparation.contracts import ContractError, contract_errors
from css_preparation.prepare.records import RecordSet
from css_preparation.runner import __main__ as runner
from css_preparation.runner.cloudflare import CloudflareConfig
from css_preparation.runner.recipes import (
    RECIPE_DIRECTORY,
    RECIPES,
    Recipe,
    declared_input,
    load_recipes,
)
from css_preparation.runner.web import Origin, ProviderError
from preparation_fixture import evidence_a, text_a
from runner_doubles import TOKEN_ID, LoopbackApi, control_client_for, storage_for
from stepbible_fixture import recipe as stepbible_recipe

ROOT = Path(__file__).resolve().parents[2]
WIRE = json.loads(
    (ROOT / "tests/conformance/dp04-control-wire.v1.json").read_text(encoding="utf-8")
)
MARKER = "PRIVATE-MARKER-7f3a"
COMMIT = "c" * 40
RUN_ID = "987654321"


def canonical(job):
    return json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def inconsistent_reader(read_rows, kind, field, altered):
    """Simulate an inconsistent read without changing the database's immutable rows."""

    def inconsistent_rows(requested, output_ids):
        rows = read_rows(requested, output_ids)
        if requested == kind:
            row = next(
                row
                for row in rows
                if kind == "reader_reference_base" or row["status"] == "missing"
            )
            row[field] = altered
        return rows

    return inconsistent_rows


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.evidence = evidence_a()
        evidence_row = self.evidence.rows("prepared_output")[0]
        self.output_id = evidence_row["id"]
        self.extent = evidence_row["native_extent_json"]
        self.revision = evidence_row["input_revisions_json"][0]
        # Acquisition saves source identities before preparation; seed them here.
        seed = RecordSet()
        for row in self.evidence.rows("source_node"):
            seed.add("source_node", row)
        with self.api.db:
            for sql, params in seed.statements():
                self.api.db.execute(sql, params)
        self.task_state = "running"
        self.results = []
        self.reply = (
            200,
            {"status": "accepted", "eligible": True, "state": "succeeded"},
        )
        self.api.control_handler = self.control
        self.storage = storage_for(self.api)
        self.client = control_client_for(self.api)
        self.initial_selection = self.selection()
        self.recipe = Recipe(
            prepare=lambda job, storage: self.evidence,
            read_source=lambda revision, storage: text_a(),
        )

    def selection(self):
        return [
            tuple(row) for row in self.api.db.execute("SELECT * FROM release_selection")
        ]

    def job(self, kind="prepare", **changes):
        job = deepcopy(WIRE["job_input"])
        job.update(
            task_id="task-gh04",
            unit_id=f"unit-{kind}",
            kind=kind,
            native_extent=dict(self.extent),
            input_refs=[{"kind": "source_revision", "id": self.revision}],
            dependency_refs=[],
            required_capabilities=["source_context"] if kind == "quality" else [],
            constraints={},
        )
        job.update(changes)
        self.current = canonical(job)
        return self.current

    def control(self, method, path, headers, body):
        request = json.loads(body)
        if path == "/internal/jobs/state":
            job = json.loads(self.current)
            # The run names itself and the digest of the exact bytes it holds.
            self.assertEqual(request["run_id"], RUN_ID)
            self.assertEqual(
                request["job_input_basis"],
                hashlib.sha256(self.current.encode("utf-8")).hexdigest(),
            )
            return 200, {
                "task_id": job["task_id"],
                "task_revision": job["task_revision"] + 1,
                "task_state": self.task_state,
                "task_basis_digest": job["basis_digest"],
                "unit_id": job["unit_id"],
                "attempt": job["attempt"],
                "job_revision": job["task_revision"],
                "job_input_basis": hashlib.sha256(
                    self.current.encode("utf-8")
                ).hexdigest(),
                "run_id": RUN_ID,
                "job_state": "dispatched",
            }
        self.results.append(request)
        return self.reply

    def run_job(self, raw, kind="prepare"):
        with mock.patch.dict(RECIPES, {"recipe-1": self.recipe}):
            return runner.run_job(
                raw, kind, run_id=RUN_ID, control=self.client, storage=self.storage
            )

    def test_prepare_unit_saves_candidate_and_valid_result(self):
        result = self.run_job(self.job())
        self.assertEqual(contract_errors("job_result", result), [])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["remaining_extent"], {})
        self.assertTrue(result["output_refs"])
        self.assertIsNotNone(self.storage.read_row("prepared_output", self.output_id))
        self.assertFalse(
            [key for key in self.api.objects if key.startswith("prepared/checkpoints/")]
        )
        # Preparation never selects data: selection unchanged, no release rows.
        self.assertEqual(self.selection(), self.initial_selection)
        self.assertEqual(
            self.api.db.execute("SELECT COUNT(*) FROM releases").fetchone()[0], 0
        )

    def test_provider_failure_reports_status_without_response_or_credentials(self):
        def fail(job, storage):
            raise ProviderError("Provider request refused", status=429, transient=True)

        self.recipe = Recipe(prepare=fail)
        result = self.run_job(self.job())
        [item] = result["diagnostics"]
        record = json.loads(item["message"])
        self.assertEqual(
            (item["code"], record["stage"], record["http"]),
            ("provider_failure", "building_output", 429),
        )
        self.assertEqual(record["message"], "Provider request refused")

    def test_unknown_recipe_and_missing_module_fail_without_writes(self):
        with mock.patch.dict(RECIPES, {}, clear=True):
            result = runner.run_job(
                self.job(),
                "prepare",
                run_id=RUN_ID,
                control=self.client,
                storage=self.storage,
            )
        self.assertEqual(
            (result["state"], result["diagnostics"][0]["code"]),
            ("failed", "no_registered_recipe"),
        )
        self.recipe = Recipe()
        result = self.run_job(self.job())
        self.assertEqual(result["diagnostics"][0]["code"], "no_registered_recipe")
        self.assertEqual(self.api.batches, [])

    def test_paused_or_cancelled_task_runs_nothing(self):
        self.task_state = "cancelled"
        result = self.run_job(self.job())
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(self.api.batches, [])

    def test_workflow_kind_must_match_dispatched_kind(self):
        with self.assertRaises(ContractError):
            self.run_job(self.job("prepare"), kind="quality")

    def test_quality_reads_candidate_from_control_constraints(self):
        self.run_job(self.job())
        result = self.run_job(
            self.job("quality", constraints={"candidate": {"added": [self.output_id]}}),
            kind="quality",
        )
        self.assertEqual(result["state"], "succeeded", result["diagnostics"])
        receipt = result["quality_receipt_ref"]
        self.assertIn(f"prepared/receipts/{receipt['sha256']}.json", self.api.objects)
        for constraints in (
            {},
            {"candidate": {"added": ["synthetic:not-saved"]}},
            {"candidate": {"added": "x"}},
        ):
            result = self.run_job(
                self.job("quality", constraints=constraints), kind="quality"
            )
            self.assertEqual(result["state"], "failed")

    def test_mapping_recipe_checks_saved_rows_and_reports_gaps(self):
        value, component, data = stepbible_recipe(
            "tagnt", groups=[["Mat.1.1"], ["Mat.1.3", "Mat.1.4"]]
        )
        value["capabilities"] = ["reader_reference"]
        value["units"][-1]["required_capabilities"] = value["capabilities"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            fetch = fetch_recipe(component)
            for item in (fetch, value):
                (path / f"{item['id']}.json").write_text(
                    json.dumps(item), encoding="utf-8"
                )
            recipes = load_recipes(path)

        self.storage.put_blob(component.original_key, data)
        inputs = [
            {"kind": "acquisition", "id": component.acquisition_id},
            {"kind": "source_revision", "id": component.revision_id},
        ]

        def run(unit, recipe=value, **changes):
            raw = self.job(
                unit["kind"],
                recipe_revision=recipe["revision"],
                unit_id=unit["unit_id"],
                native_extent=unit["native_extent"],
                input_refs=inputs,
                required_capabilities=unit.get("required_capabilities", []),
                **changes,
            )
            return runner.run_job(
                raw,
                unit["kind"],
                run_id=RUN_ID,
                control=self.client,
                storage=self.storage,
                recipes=recipes,
            )

        baseline, exceptions, quality = value["units"]
        [acquire] = fetch["units"]
        self.assertEqual(run(acquire, fetch)["state"], "succeeded")
        baseline_result, exception_result = run(baseline), run(exceptions)
        for result in (baseline_result, exception_result):
            self.assertEqual(result["state"], "succeeded", result["diagnostics"])
        [manifest] = baseline_result["output_refs"]
        self.assertTrue(manifest["artifact_id"].endswith(":reader-manifest"))
        artifacts = baseline_result["output_refs"] + exception_result["output_refs"]
        ids = sorted(
            {
                self.storage.read_row("artifact", item["artifact_id"])["output_id"]
                for item in artifacts
            }
        )
        self.assertEqual(len(ids), 2)

        def check(ids):
            return run(
                quality,
                constraints={"candidate": {"added": ids}},
                dependency_refs=artifacts,
            )

        result = check(ids)
        self.assertEqual(result["state"], "succeeded", result["diagnostics"])
        ref = result["quality_receipt_ref"]
        receipt = json.loads(self.storage.receipt_store().load(ref))
        self.assertEqual(receipt["actual_capabilities"], ["reader_reference"])
        self.assertIn("reader_references", receipt["checks"])
        self.assertTrue(
            any(
                item.startswith("Matt.1.4 (numbered_text):")
                for item in receipt["limitations"]
            )
        )
        self.assertEqual(check(ids[:1])["state"], "failed")

        read_rows = self.storage.read_rows
        for kind, field, altered in (
            (
                "reader_reference_base",
                "checked_extent_json",
                {
                    "ranges": [
                        {
                            "book_id": "Matt",
                            "chapter": 1,
                            "first_verse": 2,
                            "last_verse": 2,
                        }
                    ]
                },
            ),
            ("reader_reference_link", "gap_reason", "Invented reason"),
        ):
            with self.subTest(kind=kind):
                inconsistent_rows = inconsistent_reader(read_rows, kind, field, altered)

                with mock.patch.object(
                    self.storage, "read_rows", side_effect=inconsistent_rows
                ):
                    failed = check(ids)
                self.assertEqual(failed["state"], "failed", failed)
                self.assertIsNone(failed["quality_receipt_ref"])
        self.assertEqual(self.selection(), self.initial_selection)

    def environ(self, raw):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        event = Path(holder.name) / "event.json"
        event.write_text(
            json.dumps(
                {
                    "inputs": {
                        "job": raw,
                        "dispatch_ref": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
                    }
                }
            ),
            encoding="utf-8",
        )
        return {
            "GITHUB_EVENT_PATH": str(event),
            "GITHUB_RUN_ID": RUN_ID,
            "GITHUB_SHA": COMMIT,
            "CONTROL_ORIGIN": self.api.origin,
            "PREPARATION_ACCESS_CLIENT_ID": "synthetic-id",
            "PREPARATION_ACCESS_CLIENT_SECRET": "synthetic-secret",
            "CLOUDFLARE_ACCOUNT_ID": "acct",
            "D1_DATABASE_ID": "db",
            "R2_BUCKET": "bucket",
            "R2_ACCESS_KEY_ID": TOKEN_ID,
            "PREPARATION_CLOUDFLARE_TOKEN": "synthetic-token",
        }

    def main(self, environ):
        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "status.txt"
            config = functools.partial(
                CloudflareConfig,
                api=Origin(self.api.origin),
                r2_origin=Origin(self.api.origin),
            )
            with (
                mock.patch.object(runner, "CloudflareConfig", config),
                mock.patch.dict(RECIPES, {"recipe-1": self.recipe}),
                contextlib.redirect_stdout(out),
                contextlib.redirect_stderr(err),
            ):
                code = runner.main(["--status", str(status)], environ)
            return (
                code,
                status.read_text(encoding="utf-8"),
                out.getvalue() + err.getvalue(),
            )

    def test_only_the_enumerated_kinds_run(self):
        for text in ('{"kind":"prepare; rm -rf /"}', "not json at all"):
            with self.subTest(text=text):
                code, status, printed = self.main(self.environ(text))
                self.assertEqual((code, status), (1, runner.PUBLIC["invalid"] + "\n"))
                self.assertTrue(printed.startswith("::error title=runner job_input::"))
        self.assertEqual(self.results, [])

    def test_main_submits_result_and_prints_only_fixed_status(self):
        code, status, printed = self.main(self.environ(self.job()))
        self.assertEqual(code, 0)
        self.assertEqual(
            status,
            "Preparation prepare unit finished: succeeded.\nControl accepted the result.\n",
        )
        self.assertEqual(printed, "")
        [sent] = self.results
        self.assertEqual(sent["commit"], COMMIT)
        self.assertEqual(sent["result"]["run_id"], RUN_ID)

    def test_private_markers_reach_only_the_private_result(self):
        def leak(job, storage):
            raise OSError(f"{MARKER} source wording and inventory detail")

        self.recipe = Recipe(prepare=leak)
        code, status, printed = self.main(self.environ(self.job()))
        self.assertEqual(code, 1)
        for public in (status, printed):
            self.assertNotIn(MARKER, public)
            self.assertNotIn("synthetic-secret", public)
            self.assertNotIn("synthetic-token", public)
        [item] = self.results[0]["result"]["diagnostics"]
        self.assertEqual(item["code"], "invalid_or_unavailable_output")
        self.assertNotIn(MARKER, item["message"])
        # The public annotation is the same record that Control stores.
        [line] = printed.splitlines()
        self.assertEqual(line, annotation(json.loads(item["message"])))
        self.assertTrue(line.startswith("::error title=prepare building_output::"))

    def test_a_crash_before_any_report_prints_a_record_and_no_traceback(self):
        out, err = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(runner, "main", side_effect=RuntimeError(MARKER)),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            code = runner.run()
        self.assertEqual(code, 1)
        self.assertEqual(err.getvalue(), "")
        self.assertNotIn(MARKER, out.getvalue())
        self.assertTrue(out.getvalue().startswith("::error title=runner startup::"))


class DeclaredInputTest(unittest.TestCase):
    """Which unsaved job inputs the reviewed recipe files vouch for."""

    def setUp(self):
        self.files = {
            path.stem: json.loads(path.read_text(encoding="utf-8"))
            for path in RECIPE_DIRECTORY.glob("*.json")
        }
        self.build = RECIPES[self.files["character-statement-0-2"]["revision"]]

    def test_every_route_a_recipe_file_names_counts_on_a_build_unit(self):
        routes = set()
        for value in self.files.values():
            # Without task_inputs (acquire-only), Control names the manifest as the route.
            inputs = value.get("task_inputs") or [
                {"kind": "acquisition", "id": value["manifest_revision"]}
            ]
            routes.update(ref["id"] for ref in inputs if ref["kind"] == "acquisition")
        self.assertGreater(len(routes), 1)
        for route in sorted(routes):
            reference = {"kind": "acquisition", "id": route}
            self.assertTrue(
                declared_input(reference, "prepare", self.build, RECIPES), route
            )

    def test_nothing_else_is_vouched_for(self):
        fetch = self.files["character-statement-0-2-fetch"]
        source = fetch["manifest_revision"]
        # A source revision is vouched for only by the acquire unit that creates it.
        created = {"kind": "source_revision", "id": source}
        self.assertTrue(
            declared_input(created, "acquire", RECIPES[fetch["revision"]], RECIPES)
        )
        for reference in (
            created,
            {"kind": "acquisition", "id": "unreviewed:route"},
            {"kind": "artifact", "id": source},
        ):
            self.assertFalse(
                declared_input(reference, "prepare", self.build, RECIPES), reference
            )


if __name__ == "__main__":
    unittest.main()

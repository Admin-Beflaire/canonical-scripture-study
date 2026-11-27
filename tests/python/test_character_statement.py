"""The statement file through the reviewed recipes: fetch, prepare and quality.

The real committed file, manifest and recipes run through the runner against the loopback
Cloudflare and Control doubles. Only the download is replaced by the committed bytes.
"""

import hashlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from css_preparation.adapters.character_statement import parse_statement
from css_preparation.prepare.records import RecordError
from css_preparation.runner.recipes import RECIPES
from runner_doubles import (
    LoopbackApi,
    control_client_for,
    dispatched_control,
    run_recipe_unit,
    storage_for,
)

ROOT = Path(__file__).resolve().parents[2]
FILE = (ROOT / "collection/character-of-god-statement.json").read_bytes()
RUN_ID = "987654321"


def read(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


MANIFEST = read("collection/manifests/character-statement-0-1.json")
FETCH = read("collection/recipes/character-statement-0-1-fetch.json")
BUILD = read("collection/recipes/character-statement-0-1.json")
SOURCE = MANIFEST["source_revision"]


class StatementFileTest(unittest.TestCase):
    def test_the_manifest_pins_the_committed_file(self):
        # A changed statement file needs a new version with its own manifest and recipes.
        self.assertEqual(
            (MANIFEST["expected_sha256"], MANIFEST["byte_count"]),
            (hashlib.sha256(FILE).hexdigest(), len(FILE)),
        )

    def test_incomplete_or_unapproved_shapes_are_refused(self):
        value = json.loads(FILE)
        for change in (
            {"wording": []},
            {"wording": "one string"},
            {"wording": [" "]},
            {"owner_approval_ref": None},
            {"statement_format": "character-statement/2"},
            {"answer": "not a statement field"},
        ):
            with self.subTest(change), self.assertRaises(RecordError):
                parse_statement(json.dumps({**value, **change}).encode())
        missing = {k: v for k, v in value.items() if k != "scripture_basis"}
        for data in (json.dumps(missing).encode(), b"not json", b"\xff"):
            with self.subTest(data[:20]), self.assertRaises(RecordError):
                parse_statement(data)


class StatementPreparationTest(unittest.TestCase):
    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.api.control_handler = dispatched_control(lambda: self.current, RUN_ID)
        self.storage = storage_for(self.api)
        self.client = control_client_for(self.api)

    def run_unit(self, recipe, unit_id, kinds=None, route=SOURCE, **changes):
        # Control gives every unit of a task all its inputs: a task that fetches and builds
        # names the acquisition route and the source revision on its build units too.
        kinds = kinds or ("acquisition", "source_revision")
        self.inputs = [
            {"kind": kind, "id": route if kind == "acquisition" else SOURCE}
            for kind in kinds
        ]
        return run_recipe_unit(
            self,
            recipe,
            unit_id,
            RUN_ID,
            task_id="task-statement",
            manifest_revision=recipe["manifest_revision"],
            **changes,
        )

    def fetch_and_prepare(self):
        receipt = SimpleNamespace(
            sha256=hashlib.sha256(FILE).hexdigest(),
            byte_count=len(FILE),
            upstream_basis="expected_sha256",
        )
        with mock.patch(
            "css_preparation.adapters.acquire_only.fetch_original",
            return_value=(FILE, receipt),
        ):
            fetched = self.run_unit(FETCH, "acquire")
        self.assertEqual(fetched["state"], "succeeded", fetched["diagnostics"])
        prepared = self.run_unit(BUILD, "prepare")
        self.assertEqual(prepared["state"], "succeeded", prepared["diagnostics"])
        # Control builds the candidate from the prepare unit's files, so there is one.
        self.assertEqual(len(prepared["output_refs"]), 1)
        [output] = self.api.db.execute("SELECT id FROM prepared_outputs").fetchall()
        return output["id"]

    def quality(self, output_id, **changes):
        return self.run_unit(
            BUILD,
            "quality",
            constraints={"candidate": {"added": [output_id]}},
            **changes,
        )

    def test_a_later_build_task_names_the_source_revision_only(self):
        output_id = self.fetch_and_prepare()
        later = ("source_revision",)
        prepared = self.run_unit(BUILD, "prepare", kinds=later, attempt=2)
        self.assertEqual(prepared["state"], "succeeded", prepared["diagnostics"])
        checked = self.quality(output_id, kinds=later)
        self.assertEqual(checked["state"], "succeeded", checked["diagnostics"])

    def test_a_route_no_fetch_recipe_declares_is_refused(self):
        self.fetch_and_prepare()
        refused = self.run_unit(BUILD, "prepare", route="unreviewed:route", attempt=2)
        self.assertEqual(refused["diagnostics"][0]["code"], "input_not_registered")

    def test_fetch_prepare_and_quality_keep_the_approved_record(self):
        output_id = self.fetch_and_prepare()
        value = json.loads(FILE)
        [row] = self.api.db.execute("SELECT * FROM character_statements").fetchall()
        self.assertEqual(
            (row["name"], row["version"], row["status"], row["owner_approval_ref"]),
            ("God's Character", "0.1", "approved", value["owner_approval_ref"]),
        )
        self.assertEqual(row["wording"], "\n\n".join(value["wording"]))
        self.assertEqual(
            json.loads(row["scripture_basis_json"]), value["scripture_basis"]
        )
        [admission] = self.api.db.execute("SELECT * FROM admissions").fetchall()
        self.assertEqual(admission["public_redistribution"], "allowed")
        self.assertEqual(admission["terms_basis"], MANIFEST["licence_basis"])
        self.assertIn("git_history", json.loads(admission["permitted_uses_json"]))
        checked = self.quality(output_id)
        self.assertEqual(checked["state"], "succeeded", checked["diagnostics"])
        receipt = json.loads(
            self.storage.receipt_store().load(checked["quality_receipt_ref"])
        )
        self.assertIn("statements", receipt["checks"])
        self.assertEqual(receipt["actual_capabilities"], ["character_statement"])
        self.assertEqual(receipt["candidate"]["output_ids"], [output_id])

    def test_quality_refuses_wording_that_differs_from_the_kept_file(self):
        output_id = self.fetch_and_prepare()
        with self.api.db:
            self.api.db.execute(
                "UPDATE character_statements SET wording = wording || ' Added.'"
            )
        checked = self.quality(output_id)
        self.assertEqual(checked["state"], "failed")
        self.assertEqual(checked["diagnostics"][0]["code"], "quality_failed")
        self.assertIn(
            "Saved character_statement differs", checked["diagnostics"][0]["message"]
        )

    def test_quality_refuses_a_statement_without_its_rebuild(self):
        output_id = self.fetch_and_prepare()
        registered = RECIPES[BUILD["revision"]]
        unverified = type(registered)(
            prepare=registered.prepare, read_source=registered.read_source
        )
        with mock.patch.dict(RECIPES, {BUILD["revision"]: unverified}):
            checked = self.quality(output_id)
        self.assertEqual(checked["state"], "failed")
        self.assertIn(
            "No registered verification for saved statements",
            checked["diagnostics"][0]["message"],
        )


if __name__ == "__main__":
    unittest.main()

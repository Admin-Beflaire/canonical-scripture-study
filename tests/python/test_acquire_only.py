"""Acquire-only recipes use the bounded transfer and retain synthetic bytes privately."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from css_preparation.acquire.transfer import TransferResult
from css_preparation.adapters.acquire_only import (
    PRIVATE_STORAGE,
    AcquireRecipe,
)
from css_preparation.prepare.records import RecordError
from css_preparation.runner.recipes import load_recipes

ROOT = Path(__file__).resolve().parents[2]


class Storage:
    """The runner storage an acquire unit uses: private objects and saved source rows."""

    def __init__(self):
        self.blobs, self.rows = {}, {}

    def put_blob(self, key, payload):
        self.blobs[key] = payload

    def read_blob(self, key):
        return self.blobs[key]

    def read_row(self, kind, identity):
        return self.rows.get(identity) if kind == "source_node" else None

    def save(self, records):
        self.rows.update({row["id"]: row for row in records.rows("source_node")})


def recipe_value(name):
    return json.loads((ROOT / f"collection/recipes/{name}.json").read_text())


def job_for(recipe):
    manifest = recipe.manifest
    return {
        "unit_id": "acquire",
        "native_extent": recipe.recipe["native_extent"],
        "input_refs": [
            {"kind": "acquisition", "id": manifest["manifest_revision"]},
            {"kind": "source_revision", "id": manifest["source_revision"]},
        ],
    }


def serving(data, upstream="etag:synthetic"):
    """A transfer that delivers these bytes, as the bounded transfer reports them."""

    def transfer(route, destination):
        destination.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        return TransferResult(
            destination, len(data), digest, upstream, True, False, False
        )

    return patch("css_preparation.acquire.fetch.transfer", side_effect=transfer)


class AcquireOnlyTest(unittest.TestCase):
    def assert_private(self, manifest):
        record = manifest["admission_record"]
        self.assertEqual(record["restrictions"], [PRIVATE_STORAGE])
        self.assertEqual(record["public_redistribution"], "unresolved")
        self.assertNotIn("git_history", record["permitted_uses"])

    def test_recipes_resolve_and_unknown_adapter_is_refused(self):
        recipes = load_recipes()
        for name in ("berean-bsb-v5-24", "sblgnt-d7f35adca9ec"):
            r = recipes[name + "/1"]
            self.assertIsNotNone(r.acquire)
            self.assertIsNone(r.prepare)
        with tempfile.TemporaryDirectory() as d:
            value = json.loads(
                (ROOT / "collection/recipes/berean-bsb-v5-24.json").read_text()
            )
            value["adapter"]["name"] = "unknown"
            Path(d, value["id"] + ".json").write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                load_recipes(Path(d))

    def test_literary_unit_acquisitions_are_private_and_acquire_only(self):
        names = (
            "web-usfm-2020",
            "unfoldingword-ult-v91",
            "unfoldingword-ust-v91",
            "opentext-context-d9f159c7",
            "step-nt-letters-77ba516a",
            "step-gospel-harmony-77ba516a",
        )
        all_recipes = load_recipes()
        for name in names:
            with self.subTest(name=name):
                self.assertIsNotNone(all_recipes[name + "/1"].acquire)
                self.assertIsNone(all_recipes[name + "/1"].prepare)
                recipe = json.loads(
                    (ROOT / "collection/recipes" / (name + ".json")).read_text()
                )
                manifest = AcquireRecipe.from_recipe(recipe).manifest
                self.assert_private(manifest)
                self.assertEqual(
                    manifest["admission"],
                    "Owner decision in the Maintenance Control task",
                )
                self.assertEqual(
                    recipe["dependencies"], [manifest["manifest_revision"]]
                )
                self.assertEqual([u["kind"] for u in recipe["units"]], ["acquire"])

    def test_step_b1_language_aids_have_private_acquire_only_routes(self):
        names = [
            "stepdata-tvtms-5de0a47f",
            "stepdata-tehmc-5de0a47f",
            "stepdata-tegmc-5de0a47f",
            "stepdata-tbesh-5de0a47f",
            "stepdata-tbesg-5de0a47f",
            "stepdata-tflsj-0-5624-5de0a47f",
            "stepdata-tflsj-extra-5de0a47f",
            "stepdata-tipnr-5de0a47f",
        ]
        central = json.loads(
            (ROOT / "collection/manifests/stepbible-data-5de0a47f35f0.json").read_text()
        )
        components = {row["component"]: row for row in central["components"]}
        self.assertEqual(central["commit"], "5de0a47f35f0fc13dfe1430d104e5db8a4285f9c")
        self.assertEqual(len(central["components"]), len(components))
        recipes = load_recipes()
        for name in names:
            with self.subTest(name=name):
                self.assertIsNotNone(recipes[name + "/1"].acquire)
                self.assertIsNone(recipes[name + "/1"].prepare)
                raw = json.loads(
                    (ROOT / "collection/recipes" / (name + ".json")).read_text()
                )
                manifest = AcquireRecipe.from_recipe(raw).manifest
                component = components[
                    name.removeprefix("stepdata-").removesuffix("-5de0a47f")
                ]
                self.assertEqual(manifest["upstream_path"], component["upstream_path"])
                self.assertEqual(
                    manifest["upstream_blob_sha"], component["upstream_blob_sha"]
                )
                self.assertEqual(
                    manifest["upstream_byte_count"], component["byte_count"]
                )
                self.assertIn(central["commit"], manifest["url"])
                self.assertEqual(
                    manifest["allowed_hosts"], ["raw.githubusercontent.com"]
                )
                self.assertLess(manifest["upstream_byte_count"], manifest["max_bytes"])
                self.assert_private(manifest)
                self.assertEqual(
                    manifest["admission"],
                    "Owner decision in the Maintenance Control task",
                )
                self.assertEqual([unit["kind"] for unit in raw["units"]], ["acquire"])
                self.assertEqual(raw["capabilities"], [])

    def test_oshb_bdb_acquisitions_are_pinned_and_private(self):
        commit = "21c9add13bc727d3a951361778e97e3ff7afd1ce"
        files = {
            "oshb-bdb-21c9add1": (
                "BrownDriverBriggs.xml",
                "21bb98cab34334cd500553addc38aca6792f7bce",
                2911253,
            ),
            "oshb-index-21c9add1": (
                "LexicalIndex.xml",
                "d11eb2078532f3119c70822bd27a91b484d4727b",
                1782592,
            ),
        }
        recipes = load_recipes()
        for name, (path, blob, size) in files.items():
            with self.subTest(name=name):
                raw = json.loads(
                    (ROOT / "collection/recipes" / (name + ".json")).read_text()
                )
                manifest = AcquireRecipe.from_recipe(raw).manifest
                self.assertIsNotNone(recipes[name + "/1"].acquire)
                self.assertIsNone(recipes[name + "/1"].prepare)
                self.assertEqual(
                    manifest["url"],
                    f"https://raw.githubusercontent.com/openscriptures/HebrewLexicon/{commit}/{path}",
                )
                self.assertEqual(manifest["upstream_blob_sha"], blob)
                self.assertEqual(manifest["upstream_byte_count"], size)
                self.assertLess(size, manifest["max_bytes"])
                self.assert_private(manifest)
                self.assertEqual([unit["kind"] for unit in raw["units"]], ["acquire"])

    def test_private_original_and_receipt(self):
        value = json.loads(
            (ROOT / "collection/recipes/sblgnt-d7f35adca9ec.json").read_text()
        )
        recipe = AcquireRecipe.from_recipe(value)
        m = recipe.manifest
        job = {
            "unit_id": "acquire",
            "native_extent": value["native_extent"],
            "input_refs": [
                {"kind": "acquisition", "id": m["manifest_revision"]},
                {"kind": "source_revision", "id": m["source_revision"]},
            ],
        }
        data = b"synthetic archive bytes"
        digest = hashlib.sha256(data).hexdigest()

        storage = Storage()

        def fake_transfer(route, destination):
            self.assertEqual(route.allowed_hosts, frozenset(m["allowed_hosts"]))
            destination.write_bytes(data)
            return TransferResult(
                destination, len(data), digest, "etag:synthetic", True, False, False
            )

        with patch("css_preparation.acquire.fetch.transfer", fake_transfer):
            records = recipe.acquire(job, storage)
        row = records.rows("source_node")[-1]
        self.assertEqual(row["details_json"]["sha256"], digest)
        self.assertEqual(row["details_json"]["byte_count"], len(data))
        self.assertEqual(storage.blobs[row["details_json"]["locator"]], data)
        self.assertEqual(
            records.rows("admission")[0]["public_redistribution"], "unresolved"
        )
        self.assertNotIn(
            "git_history", records.rows("admission")[0]["permitted_uses_json"]
        )
        self.assertEqual(records.rows("prepared_output"), [])
        bad = deepcopy(job)
        bad["input_refs"] = []
        with self.assertRaises(RecordError):
            recipe.acquire(bad, storage)

    def test_a_kept_original_is_verified_and_nothing_is_downloaded(self):
        # A real route that pins no digest: the saved revision records what was kept.
        recipe = AcquireRecipe.from_recipe(recipe_value("sblgnt-d7f35adca9ec"))
        self.assertIsNone(recipe.manifest.get("expected_sha256"))
        storage, data = Storage(), b"synthetic archive bytes"
        with serving(data):
            first = recipe.acquire(job_for(recipe), storage)
        storage.save(first)
        with serving(b"a newer upload", "etag:newer") as fetched:
            again = recipe.acquire(job_for(recipe), storage)
        fetched.assert_not_called()
        for kind in ("source_node", "admission"):
            self.assertEqual(again.rows(kind), first.rows(kind))

    def test_a_damaged_kept_original_stops_the_fetch(self):
        recipe = AcquireRecipe.from_recipe(recipe_value("sblgnt-d7f35adca9ec"))
        storage = Storage()
        with serving(b"synthetic archive bytes"):
            storage.save(recipe.acquire(job_for(recipe), storage))
        (key,) = storage.blobs
        storage.blobs[key] = b"damaged"
        with serving(b"x") as fetched, self.assertRaisesRegex(RecordError, "stored"):
            recipe.acquire(job_for(recipe), storage)
        fetched.assert_not_called()

    def test_a_missing_original_is_saved_only_when_it_matches_the_record(self):
        recipe = AcquireRecipe.from_recipe(recipe_value("sblgnt-d7f35adca9ec"))
        storage, data = Storage(), b"synthetic archive bytes"
        with serving(data):
            first = recipe.acquire(job_for(recipe), storage)
        storage.save(first)
        storage.blobs.clear()
        with serving(b"other bytes") as fetched:
            with self.assertRaisesRegex(RecordError, "differ from those recorded"):
                recipe.acquire(job_for(recipe), storage)
        fetched.assert_called_once()
        self.assertEqual(storage.blobs, {})
        # The same bytes under a new transfer basis restore the original; the saved identity
        # stays exactly as recorded, so the shared rows do not conflict.
        with serving(data, "etag:newer"):
            again = recipe.acquire(job_for(recipe), storage)
        self.assertEqual(list(storage.blobs.values()), [data])
        self.assertEqual(again.rows("source_node"), first.rows("source_node"))

    def test_a_pinned_original_kept_without_a_record_is_registered_without_a_download(
        self,
    ):
        recipe = AcquireRecipe.from_recipe(
            recipe_value("character-statement-0-2-fetch")
        )
        data = (ROOT / "collection/character-of-god-statement.json").read_bytes()
        storage = Storage()
        digest = recipe.manifest["expected_sha256"]
        key = f"originals/{recipe.manifest['source_revision']}/{digest}/original"
        storage.blobs[key] = data
        with serving(data) as fetched:
            records = recipe.acquire(job_for(recipe), storage)
        fetched.assert_not_called()
        node = records.rows("source_node")[-1]
        self.assertEqual(node["details_json"]["sha256"], digest)
        self.assertEqual(node["details_json"]["locator"], key)

    def test_the_manifest_states_the_whole_admission_record(self):
        manifest_dir = ROOT / "collection/manifests"
        for name in ("sblgnt-d7f35adca9ec", "character-statement-0-2-fetch"):
            value = recipe_value(name)
            filename = value["parameters"]["manifest"]
            manifest = json.loads((manifest_dir / filename).read_text())
            recipe = AcquireRecipe.from_recipe(value)
            record = manifest["admission_record"]
            self.assertEqual(
                recipe.admission["terms_basis"], record["terms_basis"], name
            )
            for field in ("permitted_uses", "restrictions", "notices"):
                self.assertEqual(recipe.admission[field + "_json"], record[field])
            for change in (
                {"both_hosts_eligible": False},
                {"restrictions": ["Anywhere"]},
                {"public_redistribution": "allowed"}
                if record["public_redistribution"] != "allowed"
                else {"public_redistribution": "unresolved"},
                {"notices": []},
                {"extra": "x"},
            ):
                changed = {**manifest, "admission_record": {**record, **change}}
                with (
                    self.subTest(name=name, change=change),
                    tempfile.TemporaryDirectory() as d,
                    patch("css_preparation.adapters.acquire_only.MANIFESTS", Path(d)),
                ):
                    Path(d, filename).write_text(json.dumps(changed))
                    with self.assertRaises(ValueError):
                        AcquireRecipe.from_recipe(value)

    def test_refuses_unknown_host(self):
        value = json.loads(
            (ROOT / "collection/recipes/berean-bsb-v5-24.json").read_text()
        )
        manifest = json.loads(
            (ROOT / "collection/manifests/berean-bsb-v5-24.json").read_text()
        )
        manifest["url"] = "https://unexpected.example/archive.zip"
        with (
            tempfile.TemporaryDirectory() as d,
            patch("css_preparation.adapters.acquire_only.MANIFESTS", Path(d)),
        ):
            Path(d, value["parameters"]["manifest"]).write_text(json.dumps(manifest))
            with self.assertRaises(RecordError):
                AcquireRecipe.from_recipe(value)

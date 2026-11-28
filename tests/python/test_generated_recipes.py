"""The committed recipes are expanded inputs with immutable revisions."""

import json
import os
import re
import subprocess
import unittest

from css_preparation.generate_recipes import committed_generated, generated_recipes
from css_preparation.recipe_source import COLLECTION, read_json
from css_preparation.recipe_templates import reader_template


def _base_file(base: str, path: str):
    result = subprocess.run(
        ["git", "show", f"{base}:collection/{path}"],
        cwd=COLLECTION.parent,
        capture_output=True,
        check=False,
    )
    return json.loads(result.stdout) if result.returncode == 0 else None


class GeneratedRecipesTest(unittest.TestCase):
    def test_committed_files_match_all_generated_values(self):
        actual, expected = committed_generated(), generated_recipes()
        self.assertEqual(set(actual), set(expected))
        for name, value in expected.items():
            with self.subTest(recipe=name):
                self.assertEqual(actual[name], value)

    def test_existing_recipe_revisions_keep_their_effective_inputs(self):
        base = os.environ.get("CHECK_BASE", "")
        if not re.fullmatch(r"[a-f0-9]{40}", base) or base == "0" * 40:
            self.skipTest("The GitHub check supplies the base commit")
        subprocess.run(
            ["git", "cat-file", "-e", f"{base}^{{commit}}"],
            cwd=COLLECTION.parent,
            check=True,
        )
        old_web = _base_file(base, "manifests/web-usfm-2020.json")
        web = read_json(COLLECTION / "manifests/web-usfm-2020.json")
        if old_web and old_web["manifest_revision"] == web["manifest_revision"]:
            self.assertEqual(
                old_web, web, "Changed WEB acquisition basis needs a new revision"
            )
        for source in ("stepbible-tahot", "stepbible-tagnt"):
            path = f"recipe-sources/{source}.json"
            previous = _base_file(base, path)
            if previous:
                profiles = read_json(COLLECTION / path)["profiles"]
                for profile, facts in previous["profiles"].items():
                    self.assertEqual(
                        profiles[profile], facts, "Add a new source profile"
                    )
        for name, value in committed_generated().items():
            old = _base_file(base, f"recipes/{name}.json")
            if old and old["revision"] == value["revision"]:
                with self.subTest(recipe=name):
                    self.assertEqual(old, value, "Changed recipe needs a new revision")

    def test_reader_join_cannot_force_a_partition_over_the_limit(self):
        units = [f"Ps.1.{number}" for number in range(1, 303)]
        with self.assertRaisesRegex(ValueError, "partition limits"):
            reader_template(
                {"native_extent": {"coordinate_version": "test/1"}},
                units,
                [["Ps.1.151", "Ps.1.152"]],
            )

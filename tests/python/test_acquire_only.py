"""Acquire-only recipes use the bounded transfer and retain synthetic bytes privately."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from css_preparation.acquire.transfer import TransferResult, TransferError
from css_preparation.adapters.acquire_only import AcquireRecipe
from css_preparation.prepare.records import RecordError
from css_preparation.runner.recipes import load_recipes

ROOT = Path(__file__).resolve().parents[2]

class AcquireOnlyTest(unittest.TestCase):
    def test_recipes_resolve_and_unknown_adapter_is_refused(self):
        recipes = load_recipes()
        for name in ('berean-bsb-v5-24', 'sblgnt-d7f35adca9ec'):
            r = recipes[name + '/1']
            self.assertIsNotNone(r.acquire)
            self.assertIsNone(r.prepare)
        with tempfile.TemporaryDirectory() as d:
            value = json.loads((ROOT / 'collection/recipes/berean-bsb-v5-24.json').read_text())
            value['adapter']['name'] = 'unknown'
            Path(d, value['id'] + '.json').write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                load_recipes(Path(d))

    def test_literary_unit_acquisitions_are_private_and_acquire_only(self):
        names = (
            'web-usfm-2020', 'unfoldingword-ult-v91', 'unfoldingword-ust-v91',
            'opentext-context-d9f159c7', 'step-nt-letters-77ba516a',
            'step-gospel-harmony-77ba516a',
        )
        all_recipes = load_recipes()
        for name in names:
            with self.subTest(name=name):
                self.assertIsNotNone(all_recipes[name + '/1'].acquire)
                self.assertIsNone(all_recipes[name + '/1'].prepare)
                recipe = json.loads((ROOT / 'collection/recipes' / (name + '.json')).read_text())
                manifest = AcquireRecipe.from_recipe(recipe).manifest
                self.assertEqual(manifest['storage'], 'Protected private storage only; never public Git')
                self.assertEqual(manifest['admission'], 'Owner decision in the Maintenance Control task')
                self.assertEqual(recipe['dependencies'], [manifest['manifest_revision']])
                self.assertEqual([u['kind'] for u in recipe['units']], ['acquire'])

    def test_private_original_and_receipt(self):
        value = json.loads((ROOT / 'collection/recipes/sblgnt-d7f35adca9ec.json').read_text())
        recipe = AcquireRecipe.from_recipe(value)
        m = recipe.manifest
        job = {'unit_id': 'acquire', 'native_extent': value['native_extent'], 'input_refs': [
            {'kind': 'acquisition', 'id': m['manifest_revision']},
            {'kind': 'source_revision', 'id': m['source_revision']}]}
        data = b'synthetic archive bytes'
        digest = hashlib.sha256(data).hexdigest()
        class Storage:
            blobs = {}
            def put_blob(self, key, payload): self.blobs[key] = payload
            def read_blob(self, key): return self.blobs[key]
        storage = Storage()
        def fake_transfer(route, destination):
            self.assertEqual(route.allowed_hosts, frozenset(m['allowed_hosts']))
            destination.write_bytes(data)
            return TransferResult(destination, len(data), digest, 'etag:synthetic', True, False, False)
        with patch('css_preparation.adapters.acquire_only.transfer', fake_transfer):
            records = recipe.acquire(job, storage)
        row = records.rows('source_node')[-1]
        self.assertEqual(row['details_json']['sha256'], digest)
        self.assertEqual(row['details_json']['byte_count'], len(data))
        self.assertEqual(storage.blobs[row['details_json']['locator']], data)
        self.assertEqual(records.rows('admission')[0]['public_redistribution'], 'unresolved')
        self.assertEqual(records.rows('prepared_output'), [])
        bad = deepcopy(job); bad['input_refs'] = []
        with self.assertRaises(RecordError): recipe.acquire(bad, storage)

    def test_refuses_unknown_host(self):
        value = json.loads((ROOT / 'collection/recipes/berean-bsb-v5-24.json').read_text())
        manifest = json.loads((ROOT / 'collection/manifests/berean-bsb-v5-24.json').read_text())
        manifest['url'] = 'https://unexpected.example/archive.zip'
        with tempfile.TemporaryDirectory() as d, patch('css_preparation.adapters.acquire_only.MANIFESTS', Path(d)):
            Path(d, value['parameters']['manifest']).write_text(json.dumps(manifest))
            with self.assertRaises(RecordError): AcquireRecipe.from_recipe(value)

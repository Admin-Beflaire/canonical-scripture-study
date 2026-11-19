"""Retain a reviewed archive without extracting or parsing it."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import tempfile
from typing import Any, Mapping
from urllib.parse import urlsplit

from ..acquire.transfer import Route, TransferError, transfer
from ..executor.checkpoints import RetryableUnitError
from ..prepare.evidence import SourceIdentity, SourceLevel
from ..prepare.records import RecordError, RecordSet
from ..validation import SCHEMAS
from . import AdapterDeclaration, AdapterRegistry

DECLARATION = AdapterDeclaration('acquire-only', 'acquire-only/1', frozenset({'archive/opaque'}),
                                 frozenset(), frozenset({'manifest'}))
MANIFESTS = SCHEMAS.parent / 'collection' / 'manifests'


@dataclass(frozen=True)
class AcquireRecipe:
    recipe: Mapping[str, Any]
    manifest: Mapping[str, Any]

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> 'AcquireRecipe':
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        params = recipe['parameters']
        name = params.get('manifest')
        if set(params) != {'manifest'} or not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*\.json', name):
            raise RecordError('Acquire-only recipe needs a manifest filename')
        manifest = json.loads((MANIFESTS / name).read_text(encoding='utf-8'))
        required = ('manifest_revision', 'source_revision', 'provider', 'origin', 'version', 'licence',
                    'licence_basis', 'attribution', 'storage', 'admission', 'url', 'allowed_hosts', 'max_bytes')
        if any(not isinstance(manifest.get(k), str) or not manifest[k] for k in required if k not in ('allowed_hosts', 'max_bytes')):
            raise RecordError('Incomplete acquisition manifest')
        hosts, limit, expected = manifest['allowed_hosts'], manifest['max_bytes'], manifest.get('expected_sha256')
        parts = urlsplit(manifest['url'])
        if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9][A-Za-z0-9._:-]*)*', manifest['source_revision'])
                or not isinstance(hosts, list) or not hosts or any(not isinstance(h, str) or not re.fullmatch(r'[a-z0-9.-]+', h) for h in hosts)
                or parts.scheme != 'https' or parts.hostname not in hosts or parts.username or parts.password
                or type(limit) is not int or not 0 < limit <= 64_000_000
                or (expected is not None and (not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected)))
                or manifest['storage'] != 'Protected private storage only; never public Git'
                or manifest['admission'] != 'Owner decision in the Maintenance Control task'
                or recipe.get('manifest_revision') != manifest['manifest_revision']
                or recipe['dependencies'] != [manifest['manifest_revision']]
                or recipe['capabilities'] or recipe['native_extent'] != {'component': manifest['source_revision']}
                or recipe.get('units') != [{'unit_id': 'acquire', 'kind': 'acquire', 'native_extent': recipe['native_extent'], 'depends_on': []}]):
            raise RecordError('Invalid acquire-only route or recipe')
        return cls(recipe, manifest)

    def declares(self, ref: Mapping[str, Any], kind: str) -> bool:
        if kind != 'acquire':
            return False
        if ref.get('kind') == 'acquisition':
            return ref == {'kind': 'acquisition', 'id': self.manifest['manifest_revision']}
        return ref == {'kind': 'source_revision', 'id': self.manifest['source_revision']}

    def acquire(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        m = self.manifest
        refs = job['input_refs']
        if (job['unit_id'] != 'acquire' or job['native_extent'] != self.recipe['native_extent']
                or not all(any(self.declares(ref, 'acquire') and ref['kind'] == kind for ref in refs)
                           for kind in ('acquisition', 'source_revision'))):
            raise RecordError('Acquisition job does not match the reviewed recipe')
        route = Route(m['manifest_revision'], m['url'], frozenset(m['allowed_hosts']), m['max_bytes'], m.get('expected_sha256'))
        with tempfile.TemporaryDirectory() as directory:
            try:
                result = transfer(route, Path(directory) / 'original')
            except TransferError as error:
                raise RecordError(f'Acquisition failed: {error}') from None
            if not result.complete:
                raise RetryableUnitError('Transfer interrupted')
            data = result.path.read_bytes()
        if len(data) != result.byte_count or hashlib.sha256(data).hexdigest() != result.sha256:
            raise RecordError('Acquired bytes differ from the transfer receipt')
        key = f"originals/{m['source_revision']}/{result.sha256}/original"
        storage.put_blob(key, data)
        if storage.read_blob(key) != data:
            raise RecordError('Retained original failed readback')
        revision = m['source_revision']
        identity = SourceIdentity(SourceLevel(revision + ':work', m['provider']),
            SourceLevel(revision + ':edition', m['provider']), SourceLevel(revision + ':archive', 'Opaque source archive'),
            SourceLevel(revision, m['version'], {'sha256': result.sha256, 'byte_count': result.byte_count,
                        'locator': key, 'upstream_basis': result.upstream_basis, 'url': m['url']}),
            m['attribution'], m['origin'])
        records = RecordSet()
        for row in identity.rows():
            records.add('source_node', row)
        records.add('admission', {'id': revision + ':archive', 'source_revision_id': revision,
            'component': 'archive', 'terms_basis': m['licence_basis'],
            'permitted_uses_json': ['acquire', 'retain', 'backup', 'prepare', 'chatgpt', 'claude'],
            'restrictions_json': [m['storage']], 'notices_json': [m['attribution'], m['licence']],
            'both_hosts_eligible': True, 'public_redistribution': 'unresolved'})
        return records

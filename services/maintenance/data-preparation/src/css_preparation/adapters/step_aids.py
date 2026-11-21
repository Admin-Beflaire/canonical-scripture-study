"""Prepare reviewed STEP and Open Scriptures language-aid entries."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from dataclasses import asdict
from typing import Any, Mapping

from ..prepare.evidence import AnnotationSpec, NativeText, OutputBasis, SourceIdentity, SourceLevel, SpanSpec, build_evidence
from ..prepare.records import RecordError, RecordSet
from . import AdapterDeclaration, AdapterRegistry
from .language_aid_entries import bdb_entries, bdb_index_entries, step_entries

METHOD_VERSION = 'language-aids/1'
INPUT_FORMAT = 'language-aids/original'
DECLARATION = AdapterDeclaration('language-aids', METHOD_VERSION, frozenset({INPUT_FORMAT}),
                                 frozenset({'lexicon_entry', 'grammar_expansion'}),
                                 frozenset({'component', 'commit', 'source_revision', 'partitions'}))
_COMPONENTS = {'tbesh', 'tbesg', 'tflsj-0-5624', 'tflsj-extra', 'tehmc', 'tegmc', 'bdb', 'bdb-index'}
_CACHE_VERSION = 1  # Bump when entry decoding, partitioning or serialization semantics change.



@dataclass(frozen=True)
class AidRecipe:
    recipe: Mapping[str, Any]
    component: str
    commit: str
    revision: str
    capability: str
    partitions: int

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> 'AidRecipe':
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        p = recipe['parameters']
        name, commit, rev, count = (p.get(k) for k in
            ('component', 'commit', 'source_revision', 'partitions'))
        if (name not in _COMPONENTS or not isinstance(commit, str)
                or not re.fullmatch(r'[0-9a-f]{40}', commit)
                or not isinstance(rev, str) or not rev
                or type(count) is not int or not 1 <= count <= 128):
            raise RecordError('Invalid language-aid recipe parameters')
        cap = 'grammar_expansion' if name in ('tehmc', 'tegmc') else 'lexicon_entry'
        coord = f'language-aids/{name}/1'
        extent = {'component': rev, 'coordinate_version': coord}
        ids = [f'p{n:03d}' for n in range(count)]
        units = [{'unit_id': f'prepare-{n:03d}', 'kind': 'prepare',
                  'native_extent': {'unit_ids': [u], 'coordinate_version': coord}, 'depends_on': []}
                 for n, u in enumerate(ids)]
        units.append({'unit_id': 'quality', 'kind': 'quality',
                      'native_extent': {'unit_ids': ids, 'coordinate_version': coord},
                      'depends_on': [u['unit_id'] for u in units], 'required_capabilities': [cap]})
        dependencies = [rev]
        if (recipe['input_format'] != INPUT_FORMAT or recipe['native_extent'] != extent
                or recipe['capabilities'] != [cap] or recipe['units'] != units
                or recipe.get('dependencies') != dependencies):
            raise RecordError('Language-aid recipe differs from its declared units')
        return cls(recipe, name, commit, rev, cap, count)

    @staticmethod
    def _original(storage: Any, revision: str) -> bytes:
        node = storage.read_row('source_node', revision)
        if not node or node.get('kind') != 'source_revision':
            raise RecordError('Acquired source revision is not registered')
        details = node.get('details_json', {})
        if not isinstance(details, dict) or not all(k in details for k in ('locator', 'sha256', 'byte_count')):
            raise RecordError('Acquired source has no verified locator')
        data = storage.read_blob(details['locator'])
        if len(data) != details['byte_count'] or hashlib.sha256(data).hexdigest() != details['sha256']:
            raise RecordError('Acquired original does not match its registration')
        return data

    def _identity(self, storage: Any) -> SourceIdentity:
        nodes = []
        current = self.revision
        for kind in ('source_revision', 'representation', 'edition', 'work'):
            node = storage.read_row('source_node', current)
            if not node or node.get('kind') != kind:
                raise RecordError('Acquired source ancestry is incomplete')
            nodes.append(node)
            current = node['parent_id']
        if current is not None:
            raise RecordError('Acquired source ancestry has an unexpected parent')
        levels = [SourceLevel(row['id'], row['name'], row['details_json']) for row in reversed(nodes)]
        return SourceIdentity(*levels, nodes[0]['attribution'], nodes[0]['origin'])

    def _native(self, storage: Any):
        original = self._original(storage, self.revision)
        if self.component == 'bdb':
            entries = bdb_entries(original, commit=self.commit)
        elif self.component == 'bdb-index':
            entries = bdb_index_entries(original, commit=self.commit)
        else:
            entries = step_entries(self.component, original, commit=self.commit)
        width = math.ceil(len(entries) / self.partitions)
        groups = [entries[i:i + width] for i in range(0, len(entries), width)]
        if len(groups) != self.partitions:
            raise RecordError('Source extent differs from reviewed partition')
        units, bases, position = [], [], 0
        for n, group in enumerate(groups):
            body = ''.join(e.body + '\n' for e in group)
            units.append((f'p{n:03d}', body))
            bases.append(position)
            position += len(body)
        return NativeText(self.recipe['native_extent']['coordinate_version'], tuple(units),
                          order_bases=tuple(bases)), groups


    def _cache_prefix(self, storage: Any) -> str:
        """Only a registered acquired original may identify a derived partition cache."""
        node = storage.read_row('source_node', self.revision)
        details = node.get('details_json', {}) if node and node.get('kind') == 'source_revision' else {}
        digest = details.get('sha256') if isinstance(details, dict) else None
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise RecordError('Acquired source has no verified digest')
        basis = json.dumps([_CACHE_VERSION, METHOD_VERSION, self.component, self.commit,
                            self.revision, digest, self.partitions], separators=(',', ':'))
        return 'prepared/language-aid-cache/v1/' + hashlib.sha256(basis.encode()).hexdigest()

    def _partition(self, storage: Any, unit: str) -> tuple[NativeText, list[Any]]:
        """Read only one already-verified partition; build the shared cache once on miss.

        Every Preparation unit runs in a separate Actions job. An in-process cache
        cannot prevent 64 independent BDB parses, but immutable private R2 partitions
        can. The cache is reconstructible, never a release artifact or source of truth.
        """
        prefix = self._cache_prefix(storage)
        key = f'{prefix}/{unit}.json'
        read_cache = getattr(storage, 'read_partition_cache', None)
        write_cache = getattr(storage, 'write_partition_cache', None)
        if callable(read_cache):
            try:
                raw = read_cache(key)
                value = json.loads(raw) if raw is not None else None
                if (isinstance(value, dict) and value.get('version') == _CACHE_VERSION
                        and value.get('prefix') == prefix and value.get('unit') == unit
                        and value.get('coordinate') == self.recipe['native_extent']['coordinate_version']
                        and type(value.get('base')) is int and value['base'] >= 0
                        and isinstance(value.get('entries'), list) and value['entries']
                        and all(isinstance(entry, dict)
                                and set(entry) == {'entry_id', 'work', 'edition', 'body', 'lookup'}
                                and all(isinstance(entry.get(k), str) for k in ('entry_id', 'work', 'edition', 'body'))
                                and isinstance(entry.get('lookup'), dict) for entry in value['entries'])):
                    from .language_aid_entries import AidEntry
                    group = [AidEntry(**entry) for entry in value['entries']]
                    text = ''.join(entry.body + '\\n' for entry in group)
                    return NativeText(value['coordinate'], ((unit, text),),
                                      order_bases=(value['base'],)), group
            except (OSError, ValueError, TypeError, KeyError):
                pass  # Invalid/missing optional cache: rederive from the pinned original.

        full, groups = self._native(storage)  # Always verifies the original before caching.
        bases = full.scalar_bases()
        if callable(write_cache):
            for i, group in enumerate(groups):
                name = f'p{i:03d}'
                value = {'version': _CACHE_VERSION, 'prefix': prefix, 'unit': name,
                         'coordinate': full.coordinate_version, 'base': bases[name],
                         'entries': [asdict(entry) for entry in group]}
                payload = json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')
                # Failed cache writes must not prevent correct preparation from original data.
                try:
                    write_cache(f'{prefix}/{name}.json', payload)
                except OSError:
                    pass
        group = groups[int(unit[1:])]
        return NativeText(full.coordinate_version, ((unit, full.unit(unit)),),
                          order_bases=(bases[unit],)), group

    def read_source(self, revision: str, storage: Any) -> NativeText:
        if revision != self.revision:
            raise RecordError('Quality requested a different source revision')
        return self._native(storage)[0]

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        scope = job.get('native_extent', {})
        if job.get('kind') != 'prepare' or not any(u['kind'] == 'prepare' and u['unit_id'] == job.get('unit_id')
                   and u['native_extent'] == scope for u in self.recipe['units']):
            raise RecordError('Language-aid unit is outside its reviewed recipe')
        refs = {ref['id'] for ref in job.get('input_refs', []) if ref.get('kind') == 'source_revision'}
        dependencies = [self.revision]
        if not set(dependencies) <= refs:
            raise RecordError('Task does not name all source revisions')
        unit = scope['unit_ids'][0]
        text, group = self._partition(storage, unit)
        spans, notes, offset = [], [], 0
        identity = self._identity(storage)
        for n, entry in enumerate(group):
            key = f'entry{n:04d}'
            end = offset + len(entry.body)
            spans.append(SpanSpec(key, self.capability, entry.entry_id, ((unit, offset, end),),
                                  'extracted' if entry.body else 'gap', {'source': self.revision, 'work': entry.work}))
            details = {'entry_id': entry.entry_id, 'entry_key': entry.entry_id,
                       'work_id': entry.work, 'edition_id': entry.edition,
                       'source_revision_id': self.revision, **entry.lookup}
            if self.component in ('bdb', 'bdb-index'):
                details['source_limitation'] = ('Open Scriptures BDB is a work in progress; '
                    'some entries, references and Hebrew words may be incomplete.')
            notes.append(AnnotationSpec(key, key, self.capability, identity.attribution,
                                        {'original': self.revision, 'entry_key': entry.entry_id}, details))
            offset = end + 1
        basis = OutputBasis('evidence', tuple(dependencies), METHOD_VERSION,
                            {'component': self.component, 'commit': self.commit, 'body_storage': 'r2'},
                            {'coordinate_version': text.coordinate_version, 'unit_ids': [unit]})
        records = build_evidence(identity, text, spans, basis,
                                 d1_body_max_bytes=0, annotations=notes,
                                 source_context_coverage=False)
        body_ids = [a['id'] for a in records.rows('artifact')]
        if len(body_ids) > 1:
            raise RecordError('Language-aid output has multiple body artifacts')
        records.add('coverage', {'output_id': basis.output_id, 'source_revision_id': self.revision,
                    'native_extent_json': {'unit_ids': [unit]}, 'capability': self.capability,
                    'state': 'available', 'method_version': METHOD_VERSION,
                    'index_artifact_id': body_ids[0] if body_ids else None, 'dependencies_json': [], 'limitation': None})
        return records

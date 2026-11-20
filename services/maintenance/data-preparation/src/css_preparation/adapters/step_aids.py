"""B2: parse already-acquired STEP lexicons and morphology explanations.

The acquisition remains the only copy of each original. This adapter stores
small attributed entry records in D1 and exact source-derived article text in
registered, immutable private R2 bodies through the existing evidence builder.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
import re
from typing import Any, Mapping

from ..prepare.evidence import (
    AnnotationSpec, NativeText, OutputBasis, SourceIdentity, SourceLevel,
    SpanSpec, build_evidence,
)
from ..prepare.records import RecordError, RecordSet
from . import AdapterDeclaration, AdapterRegistry

METHOD_VERSION = 'step-language-aids/1'
INPUT_FORMAT = 'stepbible/language-aids-tsv'
COMMIT = '5de0a47f35f0fc13dfe1430d104e5db8a4285f9c'
PROVIDER = 'STEPBible.org / Tyndale House Cambridge'
# The B1-acquired revisions are also the source identities for these prepared
# works. TFLSJ's two files share one work and edition but keep distinct revisions.
COMPONENTS = {
    'tbesh': ('stepdata-tbesh-5de0a47f/1', 'TBESH', 'lexicon_entry', 60),
    'tbesg': ('stepdata-tbesg-5de0a47f/1', 'TBESG', 'lexicon_entry', 64),
    'tflsj-0-5624': ('stepdata-tflsj-0-5624-5de0a47f/1', 'TFLSJ', 'lexicon_entry', 32),
    'tflsj-extra': ('stepdata-tflsj-extra-5de0a47f/1', 'TFLSJ', 'lexicon_entry', 30),
    'tehmc': ('stepdata-tehmc-5de0a47f/1', 'TEHMC', 'grammar_expansion', 6),
    'tegmc': ('stepdata-tegmc-5de0a47f/1', 'TEGMC', 'grammar_expansion', 10),
}
DECLARATION = AdapterDeclaration(
    'step-language-aids', METHOD_VERSION, frozenset({INPUT_FORMAT}),
    frozenset({'lexicon_entry', 'grammar_expansion'}),
    frozenset({'component'}),
)
_LEXICON_ROW = re.compile(r'^[HG][0-9]{4,5}\t')
_FULL_GRAMMAR = re.compile(r'^[A-Za-z][A-Za-z0-9_+/-]*\tFunction=')


@dataclass(frozen=True)
class Entry:
    key: str
    text: str
    details: dict[str, str]


def lexicon_entries(raw: str, work: str) -> list[Entry]:
    """Keep every separate extended Strong's entry, including homonyms."""
    rows: list[Entry] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        if not _LEXICON_ROW.match(line):
            continue
        cells = line.split('\t')
        if len(cells) != 8:
            raise RecordError(f'{work}: lexicon row is not eight fields')
        root, relation, key, spelling, transliteration, morphology, gloss, article = cells
        if not re.fullmatch(r'[HG][0-9]{4,5}[A-Za-z]?', key) or key in seen:
            raise RecordError(f'{work}: missing or duplicate extended Strong identity')
        seen.add(key)
        # An empty dictionary article still has an attributed source gloss; no
        # invented definition is supplied.
        content = article if article.strip() else gloss
        if not content:
            raise RecordError(f'{work}: empty article and gloss for {key}')
        rows.append(Entry(key, content, {
            'entry_key': key, 'strong_base': root, 'relation': relation,
            'spelling': spelling, 'transliteration': transliteration,
            'lexical_morphology': morphology, 'gloss': gloss,
            'text_field': 'article' if article.strip() else 'gloss',
        }))
    if not rows:
        raise RecordError(f'{work}: no lexicon rows in admitted original')
    return rows


def grammar_entries(raw: str, work: str) -> list[Entry]:
    """Read brief lexical codes and full occurrence codes without conflating them."""
    brief_at = raw.find('Code\tExample in English\tMeaning')
    full_at = raw.find('FULL MORPHOLOGY CODES:')
    if brief_at < 0 or full_at <= brief_at:
        raise RecordError(f'{work}: grammar section headings are missing')
    entries: list[Entry] = []
    seen: set[str] = set()
    for line in raw[brief_at:full_at].splitlines()[1:]:
        cells = line.split('\t')
        if len(cells) < 3:
            continue
        code, example, meaning = cells[:3]
        if not code or not meaning or code.startswith('=') or code in seen:
            continue
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9:/+ -]*', code):
            continue
        seen.add(code)
        entries.append(Entry(code, meaning, {
            'code': code, 'code_kind': 'brief', 'summary': meaning,
            'example': example,
        }))
    lines = raw[full_at:].splitlines()
    for index, line in enumerate(lines):
        if not _FULL_GRAMMAR.match(line):
            continue
        code, parsing = line.split('\t', 1)
        if code in seen:
            raise RecordError(f'{work}: duplicate morphology code {code}')
        seen.add(code)
        phrases: list[str] = []
        for next_line in lines[index + 1:index + 4]:
            if not next_line.startswith('\t'):
                break
            phrases.append(next_line.lstrip('\t').strip().strip('"'))
        if len(phrases) < 2:
            raise RecordError(f'{work}: missing explanation for {code}')
        entries.append(Entry(code, '\n'.join([parsing, *phrases]), {
            'code': code, 'code_kind': 'full', 'summary': phrases[0],
            'explanation': phrases[1],
        }))
    if not entries:
        raise RecordError(f'{work}: no morphology codes in admitted original')
    return entries


def partition_entries(entries: list[Entry], count: int) -> list[list[Entry]]:
    if not entries or not 1 <= count <= 64:
        raise RecordError('Invalid STEP aid partition count')
    width = math.ceil(len(entries) / count)
    result = [entries[start:start + width] for start in range(0, len(entries), width)]
    if len(result) != count:
        raise RecordError('STEP aid record extent changed; revise and review its recipe partitions')
    return result


@dataclass(frozen=True)
class AidRecipe:
    recipe: Mapping[str, Any]
    component: str
    revision: str
    work: str
    capability: str
    partitions: int

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> 'AidRecipe':
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        name = recipe.get('parameters', {}).get('component')
        if name not in COMPONENTS or set(recipe['parameters']) != {'component'}:
            raise RecordError('Unknown or unsupported STEP aid component')
        revision, work, capability, parts = COMPONENTS[name]
        coord = f'step-language-aids/{name}/1'
        extent = {'component': revision, 'coordinate_version': coord}
        groups = [f'p{n:03d}' for n in range(parts)]
        units = [
            {'unit_id': f'prepare-{n:03d}', 'kind': 'prepare',
             'native_extent': {'unit_ids': [unit], 'coordinate_version': coord},
             'depends_on': []}
            for n, unit in enumerate(groups)
        ]
        units.append({
            'unit_id': 'quality', 'kind': 'quality',
            'native_extent': {'unit_ids': groups, 'coordinate_version': coord},
            'depends_on': [unit['unit_id'] for unit in units],
            'required_capabilities': [capability],
        })
        if (recipe['input_format'] != INPUT_FORMAT or recipe['native_extent'] != extent
                or recipe['capabilities'] != [capability]
                or recipe['units'] != units
                or recipe.get('dependencies') != [revision]
                or recipe['revision'] != f'step-aids-{name}/1'):
            raise RecordError('STEP aid recipe differs from its reviewed units')
        return cls(recipe, name, revision, work, capability, parts)

    def _original(self, storage: Any) -> str:
        node = storage.read_row('source_node', self.revision)
        if not node or node.get('kind') != 'source_revision':
            raise RecordError('B1-acquired source revision is not registered')
        details = node.get('details_json', {})
        if not isinstance(details, dict) or not all(name in details for name in ('locator', 'sha256', 'byte_count')):
            raise RecordError('B1 origin registration has no verified locator')
        data = storage.read_blob(details['locator'])
        if len(data) != details['byte_count'] or hashlib.sha256(data).hexdigest() != details['sha256']:
            raise RecordError('B1 original readback digest disagrees with its registration')
        try:
            return data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise RecordError('STEP source is not valid UTF-8') from None

    def _source_identity(self, storage: Any) -> SourceIdentity:
        nodes = []
        current = self.revision
        for kind in ('source_revision', 'representation', 'edition', 'work'):
            node = storage.read_row('source_node', current)
            if not node or node.get('kind') != kind:
                raise RecordError('B1 source ancestry is incomplete')
            nodes.append(node)
            current = node['parent_id']
        if current is not None:
            raise RecordError('B1 source ancestry has an unexpected parent')
        levels = [SourceLevel(row['id'], row['name'], row['details_json']) for row in reversed(nodes)]
        leaf = nodes[0]
        return SourceIdentity(*levels, leaf['attribution'], leaf['origin'])

    def _native(self, storage: Any) -> tuple[NativeText, list[list[Entry]]]:
        original = self._original(storage)
        entries = (lexicon_entries(original, self.work) if self.capability == 'lexicon_entry'
                   else grammar_entries(original, self.work))
        parts = partition_entries(entries, self.partitions)
        units: list[tuple[str, str]] = []
        bases: list[int] = []
        position = 0
        for index, group in enumerate(parts):
            # Each article's exact source-derived text occupies its own span.
            body = ''.join(entry.text + '\n' for entry in group)
            units.append((f'p{index:03d}', body))
            bases.append(position)
            position += len(body)
        text = NativeText(self.recipe['native_extent']['coordinate_version'],
                          tuple(units), order_bases=tuple(bases))
        return text, parts

    def read_source(self, revision: str, storage: Any) -> NativeText:
        if revision != self.revision:
            raise RecordError('Quality requested a different STEP aid original')
        return self._native(storage)[0]

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        scope = job.get('native_extent', {})
        group = scope.get('unit_ids')
        if (job.get('kind') != 'prepare' or not isinstance(group, list) or len(group) != 1
                or scope.get('coordinate_version') != self.recipe['native_extent']['coordinate_version']
                or not any(u['kind'] == 'prepare' and u['unit_id'] == job.get('unit_id')
                           and u['native_extent'] == scope for u in self.recipe['units'])):
            raise RecordError('STEP aid unit is outside its reviewed recipe')
        full, groups = self._native(storage)
        unit = group[0]
        index = int(unit[1:])
        body = full.unit(unit)
        base = full.scalar_bases()[unit]
        evidence_text = NativeText(full.coordinate_version, ((unit, body),), order_bases=(base,))
        spans = []
        notes = []
        offset = 0
        for ordinal, entry in enumerate(groups[index]):
            key = f'entry{ordinal:03d}'
            end = offset + len(entry.text)
            label = f'{self.work} {entry.key}'
            spans.append(SpanSpec(key, self.capability, label, ((unit, offset, end),),
                                  'extracted', {'source': self.revision, 'work': self.work}))
            details = {
                **entry.details, 'work_id': f'step:{self.work}',
                'edition_id': f'step:{self.work}:{COMMIT}', 'entry_id': entry.key,
                'source_revision_id': self.revision,
            }
            notes.append(AnnotationSpec(key, key, self.capability, PROVIDER,
                                        {'original': self.revision, 'entry_key': entry.key}, details))
            offset = end + 1
        basis = OutputBasis('evidence', (self.revision,), METHOD_VERSION,
                            {'component': self.component, 'work': self.work,
                             'edition': COMMIT, 'body_storage': 'r2'},
                            {'coordinate_version': full.coordinate_version, 'unit_ids': [unit]})
        records = build_evidence(self._source_identity(storage), evidence_text, spans, basis,
                                 d1_body_max_bytes=0, annotations=notes)
        body_ids = [a['id'] for a in records.rows('artifact')]
        if len(body_ids) != 1:
            raise RecordError('Lexicon or grammar output needs exactly one private body artifact')
        records.add('coverage', {
            'output_id': basis.output_id, 'source_revision_id': self.revision,
            'native_extent_json': {'unit_ids': [unit]}, 'capability': self.capability,
            'state': 'available', 'method_version': METHOD_VERSION,
            'index_artifact_id': body_ids[0], 'dependencies_json': [], 'limitation': None,
        })
        return records

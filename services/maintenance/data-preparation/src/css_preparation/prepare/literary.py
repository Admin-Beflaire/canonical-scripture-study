"""Literary units and admitted versification mappings.

Literary units are native spans whose boundaries Maintenance identified, possibly
discontinuous and possibly disputed. Mappings come only from admitted mapping data:
a verse is linked to another source's verse only when an admitted mapping says so,
never because the two share a number or label.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from css_shared import mappings_for, serialize_reference

from .evidence import NativeText, OutputBasis, SpanSpec
from .records import RecordError, RecordSet

BOUNDARY_STATUSES = ('agreed', 'disputed')
# Admitted mapping status -> (relationship status, member correspondence).
_STATUS = {'exact': ('supported', 'exact'), 'partial': ('supported', 'partial'), 'disputed': ('disputed', 'unresolved'),
           'missing': ('supported', 'missing'), 'unresolved': ('unresolved', 'unresolved')}


@dataclass(frozen=True)
class LiteraryUnit:
    key: str
    label: str
    segments: tuple[tuple[str, int, int], ...]
    provider: str
    method: str
    boundary_status: str = 'agreed'
    # Competing boundaries, each {'attribution': str, 'segments': ((unit, start, end), ...)}.
    alternatives: tuple[Mapping[str, Any], ...] = ()
    reading_kind: str = 'extracted'
    parent_key: str | None = None
    notes: Mapping[str, Any] = field(default_factory=dict)


def _ordered_segments(text: NativeText, segments: Iterable[tuple[str, int, int]], key: str) -> list[dict[str, Any]]:
    bases = text.scalar_bases()
    previous_end = -1
    result = []
    for unit_id, start, end in segments:
        body = text.unit(unit_id)
        if not (isinstance(start, int) and isinstance(end, int)) or not 0 <= start <= end <= len(body):
            raise RecordError(f'Literary unit {key}: segment {unit_id} {start}-{end} is outside its unit')
        linear = bases[unit_id] + start
        if linear < previous_end:
            raise RecordError(f'Literary unit {key}: segments must follow source order without overlap')
        previous_end = bases[unit_id] + end
        result.append({'unit_id': unit_id, 'start': start, 'end': end})
    if not result:
        raise RecordError(f'Literary unit {key} has no segments')
    return result


def literary_spans(text: NativeText, units: Iterable[LiteraryUnit]) -> list[SpanSpec]:
    """Check boundaries and alternatives against the native text and return the span specifications."""
    specs = []
    for unit in units:
        if unit.boundary_status not in BOUNDARY_STATUSES:
            raise RecordError(f'Literary unit {unit.key}: unknown boundary status {unit.boundary_status}')
        if not unit.provider or not unit.method:
            raise RecordError(f'Literary unit {unit.key} needs an attributed boundary method')
        if unit.boundary_status == 'agreed' and unit.alternatives:
            raise RecordError(f'Literary unit {unit.key}: alternatives mean the boundary is disputed')
        if unit.boundary_status == 'disputed' and not unit.alternatives:
            raise RecordError(f'Literary unit {unit.key}: a disputed boundary keeps its alternatives')
        _ordered_segments(text, unit.segments, unit.key)
        alternatives = []
        for alternative in unit.alternatives:
            if set(alternative) != {'attribution', 'segments'} or not alternative['attribution']:
                raise RecordError(f'Literary unit {unit.key}: alternative needs attribution and segments')
            alternatives.append({'attribution': alternative['attribution'],
                                 'segments': _ordered_segments(text, alternative['segments'], unit.key)})
        basis = {**dict(unit.notes), 'provider': unit.provider, 'method': unit.method,
                 'boundary_status': unit.boundary_status, 'alternatives': alternatives}
        specs.append(SpanSpec(unit.key, 'literary_unit', unit.label, tuple(unit.segments), unit.reading_kind, basis,
                              unit.parent_key))
    return specs


def span_index(spans: Iterable[Mapping[str, Any]]) -> dict[str, tuple[str, str]]:
    """Serialized native reference -> (span id, output id), for exact endpoint resolution."""
    index: dict[str, tuple[str, str]] = {}
    for span in spans:
        key = serialize_reference({'schema_version': 'native-reference/1',
                                   'source_revision_id': span['source_revision_id'],
                                   'coordinate_version': span['coordinate_version'], 'segments': span['segments_json']})
        found = (span['id'], span['output_id'])
        if index.setdefault(key, found) != found:
            raise RecordError(f'Two spans share the native reference of {span["id"]}')
    return index


def mapping_relationships(mappings: Iterable[Mapping[str, Any]], spans: Mapping[str, tuple[str, str]],
                          basis: OutputBasis, *, provider: str, kind: str = 'versification_mapping') -> RecordSet:
    """Attributed relationships from admitted mappings; partial, disputed and missing matches are kept.

    `basis.input_revisions` starts with the admitted mapping revision; `basis.dependencies` must
    name every output whose spans are endpoints, so changed sources rebuild their mappings.
    """
    if not provider:
        raise RecordError('Mappings need an attributed provider')
    records = RecordSet()
    output_id = basis.output_id
    records.add('prepared_output', basis.row())
    used_outputs: set[str] = set()
    covered: dict[str, set[str]] = {}

    def endpoint(reference: Mapping[str, Any]) -> str:
        found = spans.get(serialize_reference(dict(reference)))
        if found is None:
            raise RecordError('Mapping endpoint has no prepared span with exactly that native reference')
        used_outputs.add(found[1])
        return found[0]

    for number, mapping in enumerate(mappings):
        [checked] = mappings_for(mapping['from'], [dict(mapping)])
        status, correspondence = _STATUS[checked['status']]
        relationship_id = f'{output_id}~{number}'
        relation_basis = {'provider': provider, 'mapping_revision': basis.input_revisions[0],
                          'mapping_status': checked['status'], 'statement': checked['basis']}
        if checked.get('gap_reason'):
            relation_basis['gap_reason'] = checked['gap_reason']
        records.add('relationship', {'id': relationship_id, 'output_id': output_id, 'kind': kind,
                                     'direction': 'directed', 'status': status, 'basis_json': relation_basis})
        records.add('relation_member', {'relationship_id': relationship_id, 'role': 'from', 'ordinal': 0,
                                        'span_id': endpoint(checked['from']), 'correspondence': 'exact',
                                        'gap_reason': None})
        targets = checked['to']
        if not targets:
            records.add('relation_member', {'relationship_id': relationship_id, 'role': 'to', 'ordinal': 0,
                                            'span_id': None, 'correspondence': correspondence,
                                            'gap_reason': checked['gap_reason']})
        for ordinal, target in enumerate(targets):
            member = 'composite' if correspondence == 'exact' and len(targets) > 1 else correspondence
            records.add('relation_member', {'relationship_id': relationship_id, 'role': 'to', 'ordinal': ordinal,
                                            'span_id': endpoint(target), 'correspondence': member,
                                            'gap_reason': None})
        source = checked['from']
        covered.setdefault(source['source_revision_id'], set()).update(s['unit_id'] for s in source['segments'])

    undeclared = sorted(used_outputs - set(basis.dependencies))
    if undeclared:
        raise RecordError('Mapping endpoints come from undeclared dependencies: ' + ', '.join(undeclared))
    for revision, units in sorted(covered.items()):
        records.add('coverage', {'output_id': output_id, 'source_revision_id': revision,
                                 'native_extent_json': {'unit_ids': sorted(units)}, 'capability': kind,
                                 'state': 'available', 'method_version': basis.method_version,
                                 'index_artifact_id': None, 'dependencies_json': sorted(basis.dependencies),
                                 'limitation': None})
    return records

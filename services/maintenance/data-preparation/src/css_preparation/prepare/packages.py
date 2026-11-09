"""Study packages, approved-statement incorporation and dependency-aware rebuild plans.

Packages are a cache of current source pointers for faster lookup: attributed held
references and external/not-held locators, with the outputs they depend on. They never
hold answers or accepted findings. The character-of-God statement enters only as the one
owner-approved name/version the task instruction names; Preparation never approves it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .evidence import OutputBasis
from .records import RecordError, RecordSet


class StatementError(RecordError):
    """The instructed statement cannot be incorporated as it stands."""


@dataclass(frozen=True)
class Holding:
    """A source revision currently held by a prepared output, with the native units it covers."""
    output_id: str
    attribution: str
    unit_ids: frozenset[str]


@dataclass(frozen=True)
class PackageSpec:
    key: str
    subject: str
    held: tuple[Mapping[str, Any], ...] = ()       # native references
    external: tuple[Mapping[str, str], ...] = ()   # {'attribution': ..., 'locator': ...}


def holdings(source_nodes: Iterable[Mapping[str, Any]], coverage: Iterable[Mapping[str, Any]]) -> dict[str, Holding]:
    """Held revisions from available or partial source-context coverage of current outputs."""
    attribution = {row['id']: row['attribution'] for row in source_nodes}
    found: dict[str, Holding] = {}
    for row in coverage:
        if row['capability'] != 'source_context' or row['state'] not in ('available', 'partial'):
            continue
        revision = row['source_revision_id']
        if revision in found:
            raise RecordError(f'Two current outputs hold {revision}')
        found[revision] = Holding(row['output_id'], attribution[revision],
                                  frozenset(row['native_extent_json'].get('unit_ids', ())))
    return found


def refresh_packages(specs: Iterable[PackageSpec], held: Mapping[str, Holding],
                     basis: OutputBasis) -> tuple[RecordSet, dict[str, list[Any]]]:
    """Rebuild packages from current holdings; references no longer held are dropped and reported."""
    if basis.kind != 'study_package':
        raise RecordError('Package output kind must be study_package')
    records = RecordSet()
    output_id = basis.output_id
    report: dict[str, list[Any]] = {'packages': [], 'dropped_references': [], 'omitted_packages': []}
    used: set[str] = set()
    rows = []
    for spec in specs:
        references, dependencies = [], set()
        for reference in spec.held:
            holding = held.get(reference.get('source_revision_id'))
            units = {segment.get('unit_id') for segment in reference.get('segments', ())}
            if holding is None or not units <= holding.unit_ids:
                report['dropped_references'].append([spec.key, reference.get('source_revision_id'),
                                                     'source extent is not currently held'])
                continue
            references.append({'availability': 'held', 'reference': dict(reference),
                               'attribution': holding.attribution})
            dependencies.add(holding.output_id)
        references += [{'availability': 'external', 'attribution': item['attribution'], 'locator': item['locator']}
                       for item in spec.external]
        if not dependencies:
            # A package exists to reach held sources faster; without one it adds nothing.
            report['omitted_packages'].append(spec.key)
            continue
        used |= dependencies
        rows.append({'id': f'{output_id}/{spec.key}', 'output_id': output_id, 'subject': spec.subject,
                     'source_refs_json': references, 'dependency_ids_json': sorted(dependencies)})
    undeclared = sorted(used - set(basis.dependencies))
    if undeclared:
        raise RecordError('Packages depend on undeclared outputs: ' + ', '.join(undeclared))
    records.add('prepared_output', basis.row())
    for row in rows:
        records.add('study_package', row)
        report['packages'].append(row['id'])
    return records, report


def incorporate_statement(instruction: Mapping[str, str] | None, statements: Iterable[Mapping[str, Any]],
                          basis: OutputBasis) -> RecordSet | None:
    """Incorporate exactly the instructed owner-approved statement version; none instructed means none."""
    if instruction is None:
        return None
    if not isinstance(instruction, Mapping) or set(instruction) != {'name', 'version', 'owner_approval_ref'}:
        raise StatementError('Instruct exactly one statement by name, version and owner approval reference')
    if basis.kind != 'character_statement':
        raise StatementError('Statement output kind must be character_statement')
    matches = [row for row in statements
               if row['name'] == instruction['name'] and row['version'] == instruction['version']]
    if len(matches) != 1:
        raise StatementError('The instructed statement version is not uniquely available')
    [statement] = matches
    if statement['status'] != 'approved' or not statement.get('owner_approval_ref'):
        raise StatementError('Only an owner-approved statement version can be incorporated')
    if statement['owner_approval_ref'] != instruction['owner_approval_ref']:
        raise StatementError('The approval reference differs from the instruction')
    if dict(basis.parameters).get('statement') != dict(instruction):
        # The statement identity is part of the reuse basis, so another version never reuses this output.
        raise StatementError('The output basis must name the instructed statement version')
    records = RecordSet()
    output_id = basis.output_id
    records.add('prepared_output', basis.row())
    records.add('character_statement', {
        'id': f'{output_id}/statement', 'output_id': output_id, 'name': statement['name'],
        'version': statement['version'], 'status': 'approved',
        'scripture_basis_json': [dict(reference) for reference in statement['scripture_basis']],
        'owner_approval_ref': statement['owner_approval_ref']})
    return records


@dataclass(frozen=True)
class RebuildPlan:
    rebuild: frozenset[str]
    omit: frozenset[str]
    retain: frozenset[str]


def dependencies_of(prepared_outputs: Iterable[Mapping[str, Any]]) -> dict[str, tuple[str, ...]]:
    return {row['id']: tuple(row['validation_basis_json'].get('dependencies', ())) for row in prepared_outputs}


def rebuild_plan(outputs: Mapping[str, Iterable[str]], changed: Iterable[str] = (),
                 removed: Iterable[str] = ()) -> RebuildPlan:
    """Changed outputs and everything depending on them are rebuilt; removed outputs are omitted.

    Every other output is retained unchanged, so a correction or removal keeps unrelated work.
    """
    graph = {output: set(dependencies) for output, dependencies in outputs.items()}
    changed, removed = set(changed), set(removed)
    unknown = sorted((changed | removed) - set(graph))
    if unknown or changed & removed:
        raise RecordError('Rebuild plan names unknown or contradictory outputs: ' + ', '.join(unknown or sorted(changed & removed)))
    affected = set(changed | removed)
    grew = True
    while grew:
        dependents = {output for output, dependencies in graph.items() if dependencies & affected} - affected
        affected |= dependents
        grew = bool(dependents)
    rebuild = affected - removed
    return RebuildPlan(frozenset(rebuild), frozenset(removed), frozenset(set(graph) - affected))

"""Build literary units from the boundary proposals of several sources.

Each source gives proposals: a scale, a label and ordered segments inside one book. The builder
compares them at verse level and returns `LiteraryUnit` records that `literary_spans` checks.

- Same scale, same verses from two or more sources: one unit, `agreed`, listing every source.
- Same scale, overlapping but different verses: one `disputed` unit. The extent given by most
  sources (the first source wins a tie) is the unit; the others are attributed alternatives.
- One source alone is one `agreed` unit that lists that single source; it is not agreement.
- Units at different scales never compete. A unit without a parent gets the smallest unit of a
  larger scale whose verses contain it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .literary import LiteraryUnit
from .records import RecordError

SCALES = ('paragraph', 'section', 'composition', 'collection', 'division', 'work')
Segment = tuple[str, int, int]


@dataclass(frozen=True)
class Proposal:
    source: str          # attribution of the boundary source or of the assistant analysis
    method: str
    scale: str
    label: str
    segments: tuple[Segment, ...]
    parent_key: str | None = None
    notes: Mapping[str, object] = field(default_factory=dict)


def _extent(proposal: Proposal, rank: Mapping[str, int]) -> frozenset[str]:
    if proposal.scale not in SCALES:
        raise RecordError(f'Unknown unit scale {proposal.scale}')
    if not proposal.segments:
        raise RecordError(f'Proposal {proposal.label} has no segments')
    for unit_id, start, end in proposal.segments:
        if unit_id not in rank:
            raise RecordError(f'Proposal {proposal.label}: {unit_id} is not in the book')
        if not 0 <= start <= end:
            raise RecordError(f'Proposal {proposal.label}: bad range in {unit_id}')
    return frozenset(unit_id for unit_id, _, _ in proposal.segments)


def _clusters(items: list[tuple[Proposal, frozenset[str]]]) -> list[list[tuple[Proposal, frozenset[str]]]]:
    """Group proposals of one scale whose verses overlap, directly or through others."""
    groups: list[list[tuple[Proposal, frozenset[str]]]] = []
    for item in items:
        touching = [g for g in groups if any(item[1] & other[1] for other in g)]
        merged = [item] + [member for g in touching for member in g]
        groups = [g for g in groups if g not in touching] + [merged]
    return groups


def build_units(book: str, order: Sequence[str], proposals: Sequence[Proposal]) -> tuple[LiteraryUnit, ...]:
    """Units of one book from every source's proposals. `order` lists the book's verse unit ids."""
    rank = {unit_id: n for n, unit_id in enumerate(order)}
    sources = list(dict.fromkeys(p.source for p in proposals))
    extents = [(p, _extent(p, rank)) for p in proposals]  # refuses every bad proposal before building
    built: list[tuple[str, int, str, frozenset[str], LiteraryUnit, str | None]] = []
    for scale in SCALES:
        items = [(p, e) for p, e in extents if p.scale == scale]
        ordered = sorted(_clusters(items), key=lambda g: min(rank[v] for _, e in g for v in e))
        for number, cluster in enumerate(ordered, start=1):
            by_extent: dict[frozenset[str], list[Proposal]] = {}
            for proposal, extent in sorted(cluster, key=lambda x: sources.index(x[0].source)):
                by_extent.setdefault(extent, []).append(proposal)
            chosen = max(by_extent, key=lambda e: (len({p.source for p in by_extent[e]}), -min(sources.index(p.source) for p in by_extent[e])))
            lead = by_extent[chosen][0]
            listed = sorted({p.source for p in by_extent[chosen]}, key=sources.index)
            others = tuple({'attribution': p.source, 'segments': p.segments}
                           for e, group in by_extent.items() if e != chosen for p in group)
            key = f'{book}:{scale}:{number:03d}'
            notes = {**dict(lead.notes), 'scale': scale, 'sources': listed, 'agreement': len(listed) > 1}
            unit = LiteraryUnit(key, lead.label, lead.segments, lead.source, lead.method,
                                'disputed' if others else 'agreed', others, parent_key=lead.parent_key, notes=notes)
            built.append((scale, number, key, chosen, unit, lead.parent_key))
    larger = {scale: n for n, scale in enumerate(SCALES)}
    result = []
    for scale, _, key, extent, unit, parent in built:
        if parent is None:
            candidates = [(len(e), k) for s, _, k, e, _, _ in built if larger[s] > larger[scale] and extent <= e]
            parent = min(candidates)[1] if candidates else None
        result.append(LiteraryUnit(unit.key, unit.label, unit.segments, unit.provider, unit.method, unit.boundary_status,
                                   unit.alternatives, unit.reading_kind, parent, unit.notes))
    return tuple(result)

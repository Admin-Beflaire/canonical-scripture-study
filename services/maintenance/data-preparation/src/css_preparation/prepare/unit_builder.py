"""Build literary units from the boundary proposals of several sources.

Units only help Study find related verses; they carry no authority. Each source gives
proposals: a scale, a label and ordered segments inside one book. The builder keeps every
proposal as a unit. Proposals with the same scale and the same verses are merged into one
unit that lists its sources. A unit without a parent gets the smallest unit of a larger
scale whose verses contain it.
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


def build_units(book: str, order: Sequence[str], proposals: Sequence[Proposal]) -> tuple[LiteraryUnit, ...]:
    """Units of one book from every source's proposals. `order` lists the book's verse unit ids."""
    rank = {unit_id: n for n, unit_id in enumerate(order)}
    sources = list(dict.fromkeys(p.source for p in proposals))
    extents = [(p, _extent(p, rank)) for p in proposals]  # refuses every bad proposal before building
    built: list[tuple[str, frozenset[str], LiteraryUnit, str | None]] = []
    for scale in SCALES:
        same: dict[frozenset[str], list[Proposal]] = {}
        for proposal, extent in extents:
            if proposal.scale == scale:
                same.setdefault(extent, []).append(proposal)
        ordered = sorted(same.items(), key=lambda item: (min(rank[v] for v in item[0]), -len(item[0])))
        for number, (extent, group) in enumerate(ordered, start=1):
            lead = group[0]
            listed = sorted({p.source for p in group}, key=sources.index)
            key = f'{book}:{scale}:{number:03d}'
            unit = LiteraryUnit(key, lead.label, lead.segments, lead.source, lead.method, parent_key=lead.parent_key,
                                notes={**dict(lead.notes), 'scale': scale, 'sources': listed})
            built.append((scale, extent, unit, lead.parent_key))
    larger = {scale: n for n, scale in enumerate(SCALES)}
    result = []
    for scale, extent, unit, parent in built:
        if parent is None:
            candidates = [(len(e), u.key) for s, e, u, _ in built if larger[s] > larger[scale] and extent <= e]
            parent = min(candidates)[1] if candidates else None
        result.append(LiteraryUnit(unit.key, unit.label, unit.segments, unit.provider, unit.method, unit.boundary_status,
                                   unit.alternatives, unit.reading_kind, parent, unit.notes))
    return tuple(result)

"""Build literary units from the boundary proposals of several sources.

Units only help Study find related verses; they carry no authority. Each source gives
proposals: a scale, a label and ordered segments inside one book. The builder keeps every
proposal as a unit. Proposals with the same scale and the same verses are merged into one
unit that lists its sources. A unit without a parent gets the smallest unit of a larger
scale whose text contains it, offsets included. Parents come only from this containment.
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
    built: list[tuple[str, frozenset[str], LiteraryUnit]] = []
    for scale in SCALES:
        same: dict[frozenset[str], list[Proposal]] = {}
        for proposal, extent in extents:
            if proposal.scale == scale:
                same.setdefault(extent, []).append(proposal)
        # Keys must not depend on input order: sort by first verse, size, then exact segments.
        ordered = sorted(same.items(), key=lambda item: (min(rank[v] for v in item[0]), -len(item[0]),
                                                         _shape(item[1][0], rank)))
        for number, (extent, group) in enumerate(ordered, start=1):
            lead = min(group, key=lambda p: (_shape(p, rank), sources.index(p.source)))
            listed = sorted({p.source for p in group}, key=sources.index)
            key = f'{book}:{scale}:{number:03d}'
            unit = LiteraryUnit(key, lead.label, lead.segments, lead.source, lead.method,
                                notes={**dict(lead.notes), 'scale': scale, 'sources': listed})
            built.append((scale, extent, unit))
    larger = {scale: n for n, scale in enumerate(SCALES)}
    result = []
    for scale, extent, unit in built:
        candidates = [(sum(e - b for _, b, e in o.segments), o.key) for s, _, o in built
                      if larger[s] > larger[scale] and _inside(unit.segments, o.segments)]
        result.append(LiteraryUnit(unit.key, unit.label, unit.segments, unit.provider, unit.method, unit.boundary_status,
                                   unit.alternatives, unit.reading_kind, min(candidates)[1] if candidates else None, unit.notes))
    return tuple(result)


def _shape(proposal: Proposal, rank: Mapping[str, int]) -> tuple[tuple[int, int, int], ...]:
    return tuple((rank[unit_id], start, end) for unit_id, start, end in proposal.segments)


def _inside(inner: Sequence[Segment], outer: Sequence[Segment]) -> bool:
    """Every inner segment lies within one outer segment of the same verse."""
    return all(any(unit_id == o_id and o_start <= start and end <= o_end for o_id, o_start, o_end in outer)
               for unit_id, start, end in inner)

"""Unit proposals from the boundary starts of a source that has its own wording.

A source such as a translation or another Greek edition cannot give offsets into the native text.
It can only say where a section or paragraph starts. This module places each start at the native
verse that holds it and turns the starts of one scale into proposals for the unit builder:

- A unit runs from its start verse to the verse before the next start of the same scale, or to the
  end of the book.
- Verses before the first start belong to no unit of that scale: the source did not say.
- Every segment is a whole verse, so two sources that start at the same verses give the same
  segments and the builder merges them. A break inside a verse is placed at that verse; the
  proposal notes record that boundaries are verse-level.

A start whose verse is not in the native book is refused, as are starts out of text order.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

from .records import RecordError
from .unit_builder import SCALES, Proposal


class NativeVerse(Protocol):
    unit_id: str
    text: str
    references: tuple[str, ...]      # English/NRSV verses of the native verse, e.g. 'Mat.1.18'


@dataclass(frozen=True)
class Start:
    reference: str                   # English/NRSV verse where the unit starts, e.g. 'Mat.1.18'
    scale: str
    label: str = ''


def proposals_from_starts(verses: Sequence[NativeVerse], book: str, starts: Sequence[Start], *,
                          source: str, method: str) -> tuple[Proposal, ...]:
    """Proposals of one source for one book: grouped by scale (in the order each scale first appears), then in text order."""
    if not verses:
        raise RecordError(f'Book {book} has no verses')
    where: dict[str, int] = {}
    for index, verse in enumerate(verses):
        for reference in verse.references:
            where.setdefault(reference, index)
    found = []
    for start in starts:
        if start.scale not in SCALES:
            raise RecordError(f'{source}: unknown unit scale {start.scale}')
        index = where.get(start.reference)
        if index is None:
            raise RecordError(f'{source}: {start.reference} has no native verse in {book}')
        found.append((start.scale, index, start.label))
    proposals = []
    for scale in dict.fromkeys(scale for scale, _, _ in found):
        marks: list[tuple[int, str]] = []
        for _, index, label in (item for item in found if item[0] == scale):
            if marks and index < marks[-1][0]:
                raise RecordError(f'{source}: {scale} starts are out of text order at {verses[index].unit_id}')
            if not marks or index > marks[-1][0]:
                marks.append((index, label))     # a second start in the same verse is the same boundary
        for number, (index, label) in enumerate(marks, start=1):
            stop = marks[number][0] if number < len(marks) else len(verses)
            segments = tuple((verse.unit_id, 0, len(verse.text)) for verse in verses[index:stop] if verse.text)
            if segments:
                proposals.append(Proposal(source, method, scale, label or f'{book} {scale} {number}', segments,
                                          {'granularity': 'verse'}))
    return tuple(proposals)

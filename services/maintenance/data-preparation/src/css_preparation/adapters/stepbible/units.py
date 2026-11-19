"""Literary units from the Masoretic paragraph markers in a TAHOT book.

The tagged text keeps the petuchah (open, `פ`) and setumah (closed, `ס`) markers as stand-alone
tokens inside the verse wording. The scribal tradition treats a petuchah as the end of a major
section and a setumah as a subdivision inside one. This module reads those markers and returns
literary units; it reads only the wording and changes nothing.

- A section runs from the end of one petuchah (or the book start) to the next petuchah (or the
  book end). Every section is a unit.
- A section that contains a setumah is divided into paragraphs at each setumah; each paragraph
  is a unit whose parent is its section.
- A marker inside a verse splits that verse at the marker; the marker itself belongs to no unit.

Boundaries come from one source, so none is disputed. Another source for the same book adds its
own units and a later step compares them.
"""
from __future__ import annotations

import re
from typing import Sequence

from ...prepare.literary import LiteraryUnit
from ...prepare.records import RecordError
from .prepare import Verse
from .source import PROVIDER, Component

METHOD = 'masoretic-paragraph-markers/1'
PETUCHAH, SETUMAH = 'פ', 'ס'
_NAMES = {PETUCHAH: 'petuchah', SETUMAH: 'setumah'}
_MARKER = re.compile('(?<![^\\s])([פס])(?![^\\s])')


def _cuts(verses: Sequence[Verse]) -> list[tuple[int, int, int, str]]:
    """(verse index, start, end, marker) of every stand-alone marker, in text order."""
    cuts = []
    for index, verse in enumerate(verses):
        for match in _MARKER.finditer(verse.text):
            start = len(verse.text[:match.start()].rstrip())
            cuts.append((index, start, match.end(), match.group(1)))
    return cuts


def _segments(verses: Sequence[Verse], begin: tuple[int, int], end: tuple[int, int]):
    """Verse pieces between two (verse index, offset) positions, trimmed of edge whitespace."""
    pieces = []
    for index in range(begin[0], end[0] + 1):
        text = verses[index].text
        stop = end[1] if index == end[0] else len(text)
        start = begin[1] if index == begin[0] else 0
        stop = len(text[:stop].rstrip())
        start += len(text[start:stop]) - len(text[start:stop].lstrip())
        if start < stop:
            pieces.append((verses[index].unit_id, start, stop))
    return tuple(pieces)


def masoretic_units(verses: Sequence[Verse], component: Component, book: str) -> tuple[LiteraryUnit, ...]:
    """Section and paragraph units of one Hebrew book, in text order."""
    if component.source.language != 'hebrew':
        raise RecordError('Masoretic paragraph markers exist only in the Hebrew text')
    if not verses:
        raise RecordError(f'Book {book} has no verses')
    end_of_book = (len(verses) - 1, len(verses[-1].text))
    position = (0, 0)
    sections: list[list[tuple[tuple[int, int], tuple[int, int], str]]] = [[]]
    for index, start, after, marker in _cuts(verses):
        if _segments(verses, position, (index, start)):
            sections[-1].append((position, (index, start), marker))
        position = (index, after)
        if marker == PETUCHAH and sections[-1]:
            sections.append([])
    if _segments(verses, position, end_of_book):
        sections[-1].append((position, end_of_book, 'end'))
    units = []
    for number, parts in enumerate((part for part in sections if part), start=1):
        key = f'{book}:masoretic:s{number:03d}'
        closing = _NAMES.get(parts[-1][2], 'book end')
        units.append(LiteraryUnit(key, f'{book} Masoretic section {number}',
                                  tuple(piece for begin, finish, _ in parts for piece in _segments(verses, begin, finish)),
                                  PROVIDER, METHOD, notes={'marker_closing': closing}))
        if len(parts) > 1:
            for sub, (begin, finish, marker) in enumerate(parts, start=1):
                units.append(LiteraryUnit(f'{key}:p{sub:02d}', f'{book} Masoretic section {number} part {sub}',
                                          _segments(verses, begin, finish), PROVIDER, METHOD, parent_key=key,
                                          notes={'marker_closing': _NAMES.get(marker, 'book end')}))
    if not units:
        raise RecordError(f'Book {book} has markers but no text to divide')
    return tuple(units)

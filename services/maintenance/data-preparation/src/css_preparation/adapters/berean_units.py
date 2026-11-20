"""Section starts from a Berean Standard Bible book in USFM.

Literary units are for context, so they are big: the Berean sections, not its paragraphs (the
Berean text starts a paragraph at almost every change of speaker). USFM marks structure with
backslash markers; this reader uses only these:

- `\\id` names the book, `\\c` the chapter, `\\v` the verse (`\\v 3-4` starts at verse 3).
- `\\s` and `\\s1` are section headings: a section starts at the next verse and keeps the heading
  as its label.

Paragraphs, poetry, `\\s2` and lower headings, parallel references, footnotes and every other marker
are not read. The reader returns starts only; `berean_units` places them on the native verses.
"""
from __future__ import annotations

import re
from typing import Sequence

from ..prepare.records import RecordError
from ..prepare.unit_starts import NativeVerse, Start, proposals_from_starts
from .stepbible.source import BOOKS

PROVIDER = 'Berean Standard Bible, BSB Publishing'
METHOD = 'bsb-usfm-sections/1'
_CODES = ('GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH',
          'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON',
          'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL',
          'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN',
          'JUD', 'REV')
USFM_CODES = dict(zip(BOOKS['tahot'] + BOOKS['tagnt'], _CODES, strict=True))
_MARKER = re.compile(r'\\(\+?[A-Za-z]+[0-9]?)(\*?)')
_SECTION = {'s', 's1'}


def _tokens(usfm: str):
    """(marker, text up to the next marker) for every opening marker."""
    found = list(_MARKER.finditer(usfm))
    for number, match in enumerate(found):
        if not match.group(2):
            end = found[number + 1].start() if number + 1 < len(found) else len(usfm)
            yield match.group(1).lstrip('+'), usfm[match.end():end]


def berean_starts(book: str, usfm: str) -> tuple[Start, ...]:
    """Section starts of one book, in text order. A book without headings has none."""
    if book not in USFM_CODES:
        raise RecordError(f'Unknown book {book}')
    starts: list[Start] = []
    label: str | None = None
    chapter = None
    named = verses = False
    for name, text in _tokens(usfm):
        if name == 'id':
            if text.split()[:1] != [USFM_CODES[book]]:
                raise RecordError(f'This USFM file is not {book} ({USFM_CODES[book]})')
            named = True
        elif name == 'c':
            number = re.match(r'\s*(\d+)', text)
            if not number:
                raise RecordError('A chapter marker has no number')
            chapter = int(number.group(1))
        elif name == 'v':
            number = re.match(r'\s*(\d+)', text)
            if not named or chapter is None or not number:
                raise RecordError('A verse marker needs a book id, a chapter and a number')
            verses = True
            if label is not None:
                starts.append(Start(f'{book}.{chapter}.{int(number.group(1))}', 'section', label))
                label = None
        elif name in _SECTION:
            label = ' '.join(text.split())
    if not named or not verses:
        raise RecordError('This USFM file has no book id or no verses')
    return tuple(starts)


def berean_units(verses: Sequence[NativeVerse], book: str, usfm: str):
    """Proposals of the Berean sections for one native book."""
    return proposals_from_starts(verses, book, berean_starts(book, usfm), source=PROVIDER, method=METHOD)

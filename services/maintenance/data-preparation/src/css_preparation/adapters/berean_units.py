"""Section and paragraph starts from a Berean Standard Bible book in USFM.

USFM marks structure with backslash markers. This reader uses only these:

- `\\id` names the book, `\\c` the chapter, `\\v` the verse (`\\v 3-4` starts at verse 3).
- `\\s` and `\\s1` are section headings: a section starts at the next verse.
- `\\p`, `\\pi`, `\\pi1`-`\\pi3` start a paragraph; the first `\\q` line after anything else starts a
  paragraph too, and later poetry lines continue it until a paragraph or a heading. A blank line
  (`\\b`) between stanzas does not end the block.
- A break that comes after some verse text, before the next `\\v`, is placed at the verse it is in.

Headings other than `\\s1`, footnotes, cross references and the other markers are not read.
The reader returns starts only; `berean_units` places them on the native verses.
"""
from __future__ import annotations

import re
from typing import Sequence

from ..prepare.records import RecordError
from ..prepare.unit_starts import NativeVerse, Start, proposals_from_starts
from .stepbible.source import BOOKS

PROVIDER = 'Berean Standard Bible, BSB Publishing'
METHOD = 'bsb-usfm-sections-paragraphs/1'
_CODES = ('GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH',
          'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON',
          'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL',
          'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN',
          'JUD', 'REV')
USFM_CODES = dict(zip(BOOKS['tahot'] + BOOKS['tagnt'], _CODES, strict=True))
_MARKER = re.compile(r'\\(\+?[A-Za-z]+[0-9]?)(\*?)')
_SECTION = {'s', 's1'}
_PARAGRAPH = {'p', 'pi', 'pi1', 'pi2', 'pi3'}
_POETRY = {'q', 'q1', 'q2', 'q3', 'q4', 'qr', 'qc', 'qm', 'qm1', 'qm2', 'qm3'}
_NOTES = {'f', 'fe', 'x'}
# Markers whose text is not verse wording.
_OTHER = {'ide', 'usfm', 'h', 'toc1', 'toc2', 'toc3', 'mt', 'mt1', 'mt2', 'ms', 'ms1', 'mr', 'r', 'sr', 'd', 'sp', 'rem',
          'cl', 's2', 's3', 's4', 'qa'}


def _tokens(usfm: str):
    """(marker, closing, text up to the next marker) for every marker."""
    found = list(_MARKER.finditer(usfm))
    for number, match in enumerate(found):
        end = found[number + 1].start() if number + 1 < len(found) else len(usfm)
        yield match.group(1).lstrip('+'), bool(match.group(2)), usfm[match.end():end]


def berean_starts(book: str, usfm: str) -> tuple[Start, ...]:
    """Section and paragraph starts of one book, in text order."""
    if book not in USFM_CODES:
        raise RecordError(f'Unknown book {book}')
    starts: list[Start] = []
    pending: dict[str, str] = {}
    chapter = verse = None
    named = poetry = False
    verse_wording = False

    def place() -> None:
        for scale in ('section', 'paragraph'):
            if scale in pending:
                starts.append(Start(f'{book}.{chapter}.{verse}', scale, pending[scale]))
        pending.clear()

    def wording(text: str) -> None:
        # Wording before the next \v while a break waits: the break is inside the verse in effect.
        if verse_wording and text.strip() and pending and verse is not None:
            place()

    for name, closing, text in _tokens(usfm):
        if closing:
            if name in _NOTES:
                verse_wording = True
            wording(text)
        elif name == 'id':
            if text.split()[:1] != [USFM_CODES[book]]:
                raise RecordError(f'This USFM file is not {book} ({USFM_CODES[book]})')
            named, verse_wording = True, False
        elif name == 'c':
            number = re.match(r'\s*(\d+)', text)
            if not number:
                raise RecordError('A chapter marker has no number')
            chapter, verse, poetry, verse_wording = int(number.group(1)), None, False, False
        elif name == 'v':
            number = re.match(r'\s*(\d+)', text)
            if not named or chapter is None or not number:
                raise RecordError('A verse marker needs a book id, a chapter and a number')
            verse, verse_wording = int(number.group(1)), True
            place()
        elif name in _SECTION:
            pending['section'] = ' '.join(text.split())
            poetry, verse_wording = False, False
        elif name in _PARAGRAPH or name in _POETRY:
            if name in _PARAGRAPH or not poetry:
                pending.setdefault('paragraph', '')
            poetry, verse_wording = name in _POETRY, True
            wording(text)
        elif name in _NOTES or name in _OTHER:
            verse_wording = False
        else:
            wording(text)
    if not named:
        raise RecordError('This USFM file has no book id')
    if not starts:
        raise RecordError(f'Book {book} has no verses with structure markers')
    return tuple(starts)


def berean_units(verses: Sequence[NativeVerse], book: str, usfm: str):
    """Proposals of the Berean sections and paragraphs for one native book."""
    return proposals_from_starts(verses, book, berean_starts(book, usfm), source=PROVIDER, method=METHOD)

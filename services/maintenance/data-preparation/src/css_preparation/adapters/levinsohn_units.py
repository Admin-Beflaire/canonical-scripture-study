"""Division starts of Matthew from the Levinsohn Greek New Testament Discourse Features (LGNTDF).

LGNTDF is clause-level discourse markup, not a list of units. One feature gives division starts: the
"Specific Circumstance" file marks `ἐγένετο` with a following time expression. The feature's own
description says that in Matthew this usually marks the major divisions of the book (its example is
7:28), while in Luke-Acts it only picks out single events. So this reader:

- reads only `Specific_Circumstance.xml` and only the book of Matthew; other books give no starts;
- leaves out 9:10, the verse the description itself names beside the Luke-Acts use of the same word;
- gives each remaining verse as the start of a `division`, to the next such verse. A division is larger than a
  `section`, so editorial sections (for example Berean headings) nest inside it. The marked verse
  closes a discourse ("when Jesus had finished these sayings"), so a start there is verse-level
  placement of a boundary that falls inside that verse.

Nothing else in LGNTDF is read: reported speech is cut into pieces (no span in Matthew reaches 20
verses), and the remaining features describe word order and prominence, not boundaries.
"""
from __future__ import annotations

import re
from typing import Sequence
from xml.parsers import expat

from ..prepare.records import RecordError
from ..prepare.unit_starts import NativeVerse, Start, proposals_from_starts
from .stepbible.source import BOOKS

PROVIDER = 'SIL International (Levinsohn Greek New Testament Discourse Features)'
METHOD = 'lgntdf-specific-circumstance/1'
LABEL = 'Division marked by ἐγένετο (Levinsohn)'
_FEATURE = 'Specific Circumstance'
_EXCLUDED = {(9, 10)}            # named in the feature's description as the Luke-Acts kind of use
_OSIS = re.compile(r'Matt\.(\d+)\.(\d+)!\d+')


def _refuse_document_type(*_: object) -> None:
    raise RecordError('LGNTDF XML with a document type declaration is refused')


def levinsohn_starts(book: str, xml: str | bytes) -> tuple[Start, ...]:
    """Division starts of one book, in text order. Every book but Matthew has none."""
    if book not in BOOKS['tagnt']:
        raise RecordError(f'{book} is not a New Testament book')
    found: list[tuple[int, int]] = []
    seen = 0

    def start(name: str, attributes: dict[str, str]) -> None:
        nonlocal seen
        if name != 'reference':
            return
        if attributes.get('type') != _FEATURE:
            raise RecordError(f'This LGNTDF file is not the {_FEATURE} feature')
        seen += 1
        osis = attributes.get('osisRef', '')
        if osis.startswith('Matt.'):
            match = _OSIS.fullmatch(osis)
            if not match:
                raise RecordError(f'An LGNTDF reference is not chapter.verse!word: {osis[:40]!r}')
            place = (int(match.group(1)), int(match.group(2)))
            if place not in _EXCLUDED:
                found.append(place)

    parser = expat.ParserCreate()
    parser.StartDoctypeDeclHandler = _refuse_document_type    # the parser sees it whatever the encoding
    parser.StartElementHandler = start
    try:
        parser.Parse(xml, True)
    except expat.ExpatError as error:
        raise RecordError('LGNTDF XML is not well formed') from error
    if not seen:
        raise RecordError('This LGNTDF file has no references')
    if book != 'Mat':
        return ()
    if not found:
        raise RecordError('The LGNTDF file marks no division of Matthew')
    if found != sorted(set(found)):
        raise RecordError('LGNTDF references of Matthew are out of text order')
    return tuple(Start(f'Mat.{chapter}.{verse}', 'division', LABEL) for chapter, verse in found)


def levinsohn_units(verses: Sequence[NativeVerse], book: str, xml: str | bytes):
    """Proposals of the Levinsohn divisions for one native book."""
    return proposals_from_starts(verses, book, levinsohn_starts(book, xml), source=PROVIDER, method=METHOD)

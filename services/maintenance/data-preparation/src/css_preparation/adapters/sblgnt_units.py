"""Paragraph starts from one SBLGNT book in XML.

The editors' paragraphing is the `p` elements of the book file. A paragraph starts at the verse
of its first `verse-number` element (`id="Matthew 1:18"`, or the text `1:18`). A `p` that begins
with wording of the verse already in effect starts inside that verse and is placed at it.
Text inside apparatus elements is not verse wording and is skipped.

The format is read as documented by the source's repository. A file that does not match (no
verse numbers, a number that is not `chapter:verse`) is refused rather than guessed at. The
reader returns starts only; `sblgnt_units` places them on the native verses.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ElementTree
from typing import Sequence

from ..prepare.records import RecordError
from ..prepare.unit_starts import NativeVerse, Start, proposals_from_starts
from .stepbible.source import BOOKS

PROVIDER = 'Society of Biblical Literature and Logos Bible Software (SBL Greek New Testament)'
METHOD = 'sblgnt-xml-paragraphs/1'
_NUMBER = re.compile(r'(\d+):(\d+)\s*$')
_APPARATUS = {'note', 'app', 'apparatus', 'footnote'}


def sblgnt_starts(book: str, xml: str | bytes) -> tuple[Start, ...]:
    """Paragraph starts of one book, in text order."""
    if book not in BOOKS['tagnt']:
        raise RecordError(f'{book} is not a New Testament book')
    raw = xml.encode('utf-8') if isinstance(xml, str) else xml
    if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
        raise RecordError('SBLGNT XML with a document type or entities is refused')
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as error:
        raise RecordError('SBLGNT XML is not well formed') from error
    starts: list[Start] = []
    state = {'verse': None, 'waiting': False}

    def place() -> None:
        starts.append(Start(f'{book}.{state["verse"][0]}.{state["verse"][1]}', 'paragraph'))
        state['waiting'] = False

    def wording(text: str | None) -> None:
        if state['waiting'] and state['verse'] is not None and text and text.strip():
            place()      # wording of the verse in effect, before any new verse number

    def visit(element: ElementTree.Element) -> None:
        if element.tag in _APPARATUS:
            return       # its tail, which is verse wording, is read by the parent
        if element.tag == 'p':
            state['waiting'] = True
        elif element.tag == 'verse-number':
            found = _NUMBER.search(element.get('id') or element.text or '')
            if not found:
                raise RecordError('A verse number is not chapter:verse')
            state['verse'] = (int(found.group(1)), int(found.group(2)))
            if state['waiting']:
                place()
            return
        wording(element.text)
        for child in element:
            visit(child)
            wording(child.tail)

    visit(root)
    if not starts:
        raise RecordError(f'Book {book} has no paragraphs with verse numbers')
    return tuple(starts)


def sblgnt_units(verses: Sequence[NativeVerse], book: str, xml: str | bytes):
    """Proposals of the SBLGNT paragraphs for one native book."""
    return proposals_from_starts(verses, book, sblgnt_starts(book, xml), source=PROVIDER, method=METHOD)

"""Paragraph starts from one SBLGNT book in XML.

The editors' paragraphing is the `p` elements of the book file. A paragraph starts at the verse
of its first `verse-number` element (`id="Matthew 1:18"`, or the text `1:18`). A `p` that begins
with wording of the verse already in effect starts inside that verse and is placed at it.
Text inside apparatus elements is not verse wording and is skipped.

The format is read as documented by the source's repository. A file that does not match is
refused rather than guessed at: a document type declaration (in any encoding), bad XML, a book
element or verse identifier that names another book, or a verse number that is not exactly
`chapter:verse`. The reader returns starts only; `sblgnt_units` places them on the native verses.
"""
from __future__ import annotations

import re
from typing import Sequence
from xml.parsers import expat

from ..prepare.records import RecordError
from ..prepare.unit_starts import NativeVerse, Start, proposals_from_starts

PROVIDER = 'Society of Biblical Literature and Logos Bible Software (SBL Greek New Testament)'
METHOD = 'sblgnt-xml-paragraphs/1'
_COORDINATE = re.compile(r'(?:(?P<name>.+?)\s+)?(?P<chapter>\d+):(?P<verse>\d+)')
_APPARATUS = {'note', 'app', 'apparatus', 'footnote'}
# Names a book goes by in the file: full name, the repository's file name, the STEPBible code.
_NAMES = {
    'Mat': ('matthew', 'matt'), 'Mrk': ('mark', 'mrk'), 'Luk': ('luke', 'luk'), 'Jhn': ('john', 'jhn'),
    'Act': ('acts', 'act'), 'Rom': ('romans', 'rom'), '1Co': ('1corinthians', '1cor'), '2Co': ('2corinthians', '2cor'),
    'Gal': ('galatians', 'gal'), 'Eph': ('ephesians', 'eph'), 'Php': ('philippians', 'phil', 'php'),
    'Col': ('colossians', 'col'), '1Th': ('1thessalonians', '1thess'), '2Th': ('2thessalonians', '2thess'),
    '1Ti': ('1timothy', '1tim'), '2Ti': ('2timothy', '2tim'), 'Tit': ('titus', 'tit'),
    'Phm': ('philemon', 'phlm', 'phm'), 'Heb': ('hebrews', 'heb'), 'Jas': ('james', 'jas'),
    '1Pe': ('1peter', '1pet'), '2Pe': ('2peter', '2pet'), '1Jn': ('1john', '1jn'), '2Jn': ('2john', '2jn'),
    '3Jn': ('3john', '3jn'), 'Jud': ('jude', 'jud'), 'Rev': ('revelation', 'rev'),
}


def _name(value: str) -> str:
    return re.sub(r'[\s.]', '', value).lower()


class _Reader:
    def __init__(self, book: str) -> None:
        self.book = book
        self.names = {*_NAMES[book], book.lower()}
        self.starts: list[Start] = []
        self.verse: tuple[int, int] | None = None
        self.waiting = False
        self.skipping = 0          # depth inside an apparatus element
        self.number: dict[str, str] | None = None

    def named(self, value: str) -> None:
        if _name(value) not in self.names:
            raise RecordError(f'This SBLGNT file names "{value}", not {self.book}')

    def place(self) -> None:
        self.starts.append(Start(f'{self.book}.{self.verse[0]}.{self.verse[1]}', 'paragraph'))
        self.waiting = False

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if self.skipping:
            self.skipping += 1
        elif name in _APPARATUS:
            self.skipping = 1
        elif name == 'book' and attributes.get('id'):
            self.named(attributes['id'])
        elif name == 'p':
            self.waiting = True
        elif name == 'verse-number':
            self.number = {'id': attributes.get('id', ''), 'text': ''}

    def data(self, text: str) -> None:
        if self.skipping:
            return
        if self.number is not None:
            self.number['text'] += text
        elif self.waiting and self.verse is not None and text.strip():
            self.place()      # wording of the verse in effect, before any new verse number

    def end(self, name: str) -> None:
        if self.skipping:
            self.skipping -= 1
        elif name == 'verse-number' and self.number is not None:
            given = (self.number['id'] or self.number['text']).strip()
            found = _COORDINATE.fullmatch(given)
            if not found:
                raise RecordError(f'A verse number is not chapter:verse: {given[:40]!r}')
            if found.group('name'):
                self.named(found.group('name'))
            self.verse = (int(found.group('chapter')), int(found.group('verse')))
            self.number = None
            if self.waiting:
                self.place()


def _refuse_document_type(*_: object) -> None:
    raise RecordError('SBLGNT XML with a document type declaration is refused')


def sblgnt_starts(book: str, xml: str | bytes) -> tuple[Start, ...]:
    """Paragraph starts of one book, in text order."""
    if book not in _NAMES:
        raise RecordError(f'{book} is not a New Testament book')
    reader = _Reader(book)
    parser = expat.ParserCreate()
    parser.buffer_text = True
    parser.StartDoctypeDeclHandler = _refuse_document_type    # the parser sees it whatever the encoding
    parser.StartElementHandler, parser.CharacterDataHandler, parser.EndElementHandler = reader.start, reader.data, reader.end
    try:
        parser.Parse(xml, True)
    except expat.ExpatError as error:
        raise RecordError('SBLGNT XML is not well formed') from error
    if not reader.starts:
        raise RecordError(f'Book {book} has no paragraphs with verse numbers')
    return tuple(reader.starts)


def sblgnt_units(verses: Sequence[NativeVerse], book: str, xml: str | bytes):
    """Proposals of the SBLGNT paragraphs for one native book."""
    return proposals_from_starts(verses, book, sblgnt_starts(book, xml), source=PROVIDER, method=METHOD)

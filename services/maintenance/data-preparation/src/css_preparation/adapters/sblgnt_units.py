"""Paragraph starts from one SBLGNT book in XML.

The editors' paragraphing is the `p` elements of the book file. A paragraph starts at the verse
of its first `verse-number` element (`id="Matthew 1:18"`, or the text `1:18`). A `p` that begins
with wording of the verse already in effect starts inside that verse and is placed at it.
Text inside apparatus and title elements is not verse wording and is skipped. Paragraph wording before
any verse number is refused: it has no verse to belong to.

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

PROVIDER = (
    "Society of Biblical Literature and Logos Bible Software (SBL Greek New Testament)"
)
METHOD = "sblgnt-xml-paragraphs/1"
_COORDINATE = re.compile(r"(?:(?P<name>.+?)\s+)?(?P<chapter>\d+):(?P<verse>\d+)")
# Names a book goes by in the file, besides its STEPBible code: the root ids and the full names in the verse
# numbers of the pinned source (every one of the 27 files was checked). A file that uses another name is
# refused with the name it uses. No name belongs to two books.
_NAMES = {
    "Mat": ("matthew", "matt", "mt"),
    "Mrk": ("mark", "mk"),
    "Luk": ("luke", "lu", "lk"),
    "Jhn": ("john", "jn"),
    "Act": ("acts", "ac"),
    "Rom": ("romans", "ro"),
    "1Co": ("1corinthians", "1cor"),
    "2Co": ("2corinthians", "2cor"),
    "Gal": ("galatians", "ga"),
    "Eph": ("ephesians",),
    "Php": ("philippians", "phil"),
    "Col": ("colossians",),
    "1Th": ("1thessalonians", "1thess"),
    "2Th": ("2thessalonians", "2thess"),
    "1Ti": ("1timothy", "1tim"),
    "2Ti": ("2timothy", "2tim"),
    "Tit": ("titus",),
    "Phm": ("philemon", "phlm"),
    "Heb": ("hebrews",),
    "Jas": ("james", "jam"),
    "1Pe": ("1peter", "1pet"),
    "2Pe": ("2peter", "2pet"),
    "1Jn": ("1john",),
    "2Jn": ("2john",),
    "3Jn": ("3john",),
    "Jud": ("jude",),
    "Rev": ("revelation", "re"),
}
_SKIPPED = {"note", "app", "apparatus", "footnote", "title"}


def _name(value: str) -> str:
    return re.sub(r"[\s.]", "", value).lower()


class _Reader:
    def __init__(self, book: str) -> None:
        self.book = book
        self.names = {*_NAMES[book], book.lower()}
        self.starts: list[Start] = []
        self.verse: tuple[int, int] | None = None
        self.waiting = False
        self.skipping = 0  # depth inside an apparatus or title element
        self.number: dict[str, str] | None = None

    def named(self, value: str) -> None:
        if _name(value) not in self.names:
            raise RecordError(
                f"This SBLGNT file names a different book than {self.book}"
            )

    def place(self) -> None:
        self.starts.append(
            Start(f"{self.book}.{self.verse[0]}.{self.verse[1]}", "paragraph")
        )
        self.waiting = False

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if self.skipping:
            self.skipping += 1
        elif name in _SKIPPED:
            self.skipping = 1
        elif name == "book" and attributes.get("id"):
            self.named(attributes["id"])
        elif name == "p":
            self.waiting = True
        elif name == "verse-number":
            self.number = {"id": attributes.get("id", ""), "text": ""}

    def data(self, text: str) -> None:
        if self.skipping:
            return
        if self.number is not None:
            self.number["text"] += text
        elif self.waiting and text.strip():
            if self.verse is None:
                raise RecordError(
                    "SBLGNT paragraph wording comes before any verse number"
                )
            self.place()  # wording of the verse in effect, before any new verse number

    def end(self, name: str) -> None:
        if self.skipping:
            self.skipping -= 1
        elif name == "verse-number" and self.number is not None:
            given = (self.number["id"] or self.number["text"]).strip()
            found = _COORDINATE.fullmatch(given)
            if not found:
                raise RecordError("A verse number is not chapter:verse")
            if found.group("name"):
                self.named(found.group("name"))
            self.verse = (int(found.group("chapter")), int(found.group("verse")))
            self.number = None
            if self.waiting:
                self.place()


def _refuse_document_type(*_: object) -> None:
    raise RecordError("SBLGNT XML with a document type declaration is refused")


def sblgnt_starts(book: str, xml: str | bytes) -> tuple[Start, ...]:
    """Paragraph starts of one book, in text order."""
    if book not in _NAMES:
        raise RecordError(f"{book} is not a New Testament book")
    reader = _Reader(book)
    parser = expat.ParserCreate()
    parser.buffer_text = True
    parser.StartDoctypeDeclHandler = (
        _refuse_document_type  # the parser sees it whatever the encoding
    )
    (
        parser.StartElementHandler,
        parser.CharacterDataHandler,
        parser.EndElementHandler,
    ) = reader.start, reader.data, reader.end
    try:
        parser.Parse(xml, True)
    except expat.ExpatError as error:
        raise RecordError("SBLGNT XML is not well formed") from error
    if not reader.starts:
        raise RecordError(f"Book {book} has no paragraphs with verse numbers")
    return tuple(reader.starts)


def sblgnt_units(verses: Sequence[NativeVerse], book: str, xml: str | bytes):
    """Proposals of the SBLGNT paragraphs for one native book."""
    return proposals_from_starts(
        verses, book, sblgnt_starts(book, xml), source=PROVIDER, method=METHOD
    )

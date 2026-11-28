"""Decode native verse wording and pre-verse descriptive titles from USFM."""

from dataclasses import dataclass, field
import re
from typing import Iterable, Iterator

from ...prepare.records import RecordError
from ..usfm_markers import BOOK, MARKER

_WORD = {"w", "wh", "wg", "wa"}
_STYLE = {
    "add",
    "bk",
    "bd",
    "bdit",
    "em",
    "it",
    "nd",
    "no",
    "pn",
    "qt",
    "qs",
    "sc",
    "sup",
    "wj",
}
_LAYOUT = re.compile(r"(?:p|m|pm|pi|mi|nb|b|q|qr|qc|qm|li)[0-9]*")
_EDITORIAL = re.compile(r"(?:s|ms|mr|sr|r|d|sp|cl|cp|h|toc|mt)[0-9]*")
_FRONT = re.compile(r"(?:ide|h|toc|mt|imt|is|ip|ili|im|iot|io|rem|sts)[0-9]*")
_NOTES = {"f", "fe", "x"}
_NUMBER = re.compile(r"[1-9][0-9]{0,3}")


def _fields(text: str) -> Iterator[tuple[str, bool, str]]:
    markers = iter(MARKER.finditer(text))
    previous = next(markers, None)
    if previous is None or text[: previous.start()].strip():
        raise RecordError("USFM member must start with a book marker")
    for marker in markers:
        yield (
            previous[1].lstrip("+"),
            bool(previous[2]),
            text[previous.end() : marker.start()],
        )
        previous = marker
    yield previous[1].lstrip("+"), bool(previous[2]), text[previous.end() :]


def _argument(payload: str) -> tuple[str, str]:
    parts = payload.split(maxsplit=1)
    return (parts[0], parts[1] if len(parts) == 2 else "") if parts else ("", "")


@dataclass
class _Body:
    verses: dict[str, list[str]] = field(default_factory=dict)
    titles: dict[str, list[str]] = field(default_factory=dict)
    pending_title: list[str] | None = None
    parts: list[str] | None = None
    verse_parts: list[str] | None = None
    in_heading: bool = False
    chapter: int = 0
    letter_style: list[str] = field(default_factory=list)
    note: str | None = None

    def inline(self, marker: str, closed: bool, payload: str) -> bool:
        if self.note is not None:
            if closed and marker == self.note:
                self.note = None
                self.append(payload)
            elif marker in {"id", "c", "v"}:
                raise RecordError("USFM note crosses a chapter or verse boundary")
            return True
        if marker in _NOTES and not closed:
            self.note = marker
            return True
        if marker not in _WORD | _STYLE:
            return False
        if closed:
            if not self.letter_style or self.letter_style.pop() != marker:
                raise RecordError("Unbalanced USFM character markup")
            self.append(payload)
        else:
            self.letter_style.append(marker)
            wording = payload.split("|", 1)[0] if marker in _WORD else payload
            # The first whitespace after a character marker delimits the marker.
            self.append(wording[1:] if wording[:1].isspace() else wording)
        return True

    def append(self, text: str) -> None:
        if self.parts is not None:
            self.parts.append(text)
        elif not self.in_heading and text.strip():
            raise RecordError("USFM wording has no numbered verse or descriptive title")

    def block(self, book: str, marker: str, payload: str) -> None:
        if marker == "v":
            number, wording = _argument(payload)
            if not self.chapter or not _NUMBER.fullmatch(number):
                raise RecordError("Expected a numbered verse within a USFM chapter")
            unit = f"{book}.{self.chapter}.{number}"
            if unit in self.verses:
                raise RecordError("Duplicate native USFM verse")
            self.verse_parts = self.parts = self.verses[unit] = [wording]
            self.in_heading = False
            if self.pending_title is not None:
                self.titles[unit + ".title"] = self.pending_title
                self.pending_title = None
        elif marker == "c":
            number, remaining = _argument(payload)
            if (
                self.pending_title is not None
                or not _NUMBER.fullmatch(number)
                or int(number) != self.chapter + 1
            ):
                raise RecordError("Unexpected USFM chapter sequence")
            self.chapter = int(number)
            self.verse_parts = self.parts = None
            self.in_heading = False
            self.append(remaining)
        elif marker == "d" and self.chapter:
            if self.pending_title is None:
                self.pending_title = []
            self.parts = self.pending_title
            self.in_heading = False
            self.append(" " + payload)
        elif _LAYOUT.fullmatch(marker):
            self.in_heading = False
            if self.parts is None:
                self.parts = self.verse_parts
            self.append(" " + payload)
        elif _EDITORIAL.fullmatch(marker) or (
            not self.chapter and _FRONT.fullmatch(marker)
        ):
            self.parts = None
            self.in_heading = True
        else:
            raise RecordError("Unsupported USFM block or character marker")


def _wording(parts: list[str]) -> str:
    # USFM wraps both prose and poetry. Fold layout whitespace and retain each
    # Unicode scalar of the published wording and punctuation.
    return " ".join("".join(parts).split())


def read_book(
    data: bytes,
    book: str,
    usfm_code: str,
    *,
    editorial_headings_before: Iterable[str] = (),
) -> tuple[dict[str, str], dict[str, str]]:
    try:
        fields = _fields(data.decode("utf-8-sig"))
    except UnicodeDecodeError:
        raise RecordError("USFM member is not UTF-8") from None
    marker, closed, payload = next(fields)
    if (
        marker != "id"
        or closed
        or not (match := BOOK.match(payload.lstrip()))
        or match[0] != usfm_code
    ):
        raise RecordError(f"USFM member does not name the requested book {book}")
    body = _Body()
    for marker, closed, payload in fields:
        if body.inline(marker, closed, payload):
            continue
        if closed or body.letter_style:
            raise RecordError("USFM character markup crosses a block boundary")
        body.block(book, marker, payload)
    if (
        body.note
        or body.letter_style
        or body.pending_title is not None
        or not body.verses
    ):
        raise RecordError("USFM body is missing or has unclosed markup")
    # Some editions use the descriptive-title marker for editorial headings.
    editorial_units = {f"{book}.{anchor}.title" for anchor in editorial_headings_before}
    if not editorial_units.issubset(body.titles):
        raise RecordError("Expected editorial headings are missing from the USFM book")
    return (
        {unit: _wording(parts) for unit, parts in body.verses.items()},
        {
            unit: _wording(parts)
            for unit, parts in body.titles.items()
            if unit not in editorial_units
        },
    )

"""Facts about a kept original. Files are inspected in memory and never extracted."""

from collections import Counter
from dataclasses import dataclass, field
import hashlib
from io import BytesIO
import json
from pathlib import PurePosixPath
import re
import stat
from typing import Any
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile, ZipInfo, is_zipfile
import zlib

from ..prepare.records import RecordError

METHOD = "source-analysis/1"
MAX_ORIGINAL_BYTES = 64_000_000
MAX_FILES = 512
MAX_REPORT_BYTES = 1_000_000
MAX_FACTS = 10_000
MAX_FACT_BYTES = 16_000
_MARKER = re.compile(r"\\(\+?[A-Za-z][A-Za-z0-9-]{0,23})(\*|(?=\s|\\|$))")
_BOOK = re.compile(r"[1-9A-Z][A-Z0-9]{2}(?=\s|$)")
_CHAPTER = re.compile(r"[1-9][0-9]{0,3}(?=\s|$)")
_VERSE = re.compile(r"([1-9][0-9]{0,2})([a-z]?)(?:-([1-9][0-9]{0,2})([a-z]?))?(?=\s|$)")


class AnalysisRefusedError(RecordError):
    """The bytes or archive cannot be analysed within the supported limits."""


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ranges(numbers: set[int]) -> list[list[int]]:
    result: list[list[int]] = []
    for number in sorted(numbers):
        if result and number == result[-1][-1] + 1:
            result[-1][1:] = [number]
        else:
            result.append([number])
    return result


def _coverage(numbers: set[int]) -> dict[str, list[list[int]]]:
    return {
        "ranges": _ranges(numbers),
        "gaps": _ranges(set(range(1, max(numbers, default=0) + 1)) - numbers),
    }


@dataclass
class Chapter:
    numbers: set[int] = field(default_factory=set)
    labels: Counter[str] = field(default_factory=Counter)

    def add(self, verse: re.Match[str]) -> bool:
        first, suffix, last, end_suffix = verse.groups()
        start, end = int(first), int(last or first)
        if end < start or end - start > 500:
            return False
        self.numbers.update(range(start, end + 1))
        label = first + suffix + (f"-{last}{end_suffix}" if last else "")
        self.labels[label] += 1
        if len(self.labels) > 1000:
            raise AnalysisRefusedError("Too many verse labels in one chapter")
        return True

    def facts(self) -> dict[str, Any]:
        coverage = _coverage(self.numbers)
        return {
            "verses": coverage["ranges"],
            "gaps": coverage["gaps"],
            "bridges_or_segments": [
                label for label in self.labels if not label.isdecimal()
            ],
            "repeats": {
                label: count for label, count in self.labels.items() if count > 1
            },
        }


@dataclass
class Usfm:
    markup: Counter[str] = field(default_factory=Counter)
    unread: Counter[str] = field(default_factory=Counter)
    chapters: dict[tuple[str, int], Chapter] = field(default_factory=dict)
    books: dict[str, Counter[int]] = field(default_factory=dict)
    book: str = ""
    chapter: int = 0

    def opening(self, marker: str, text: str, offset: int) -> None:
        if marker == "id":
            book = _BOOK.match(text, offset)
            self.book = book[0] if book else ""
            self.chapter = 0
            if self.book:
                self.books.setdefault(self.book, Counter())
            else:
                self.unread["id"] += 1
        elif marker == "c":
            chapter = _CHAPTER.match(text, offset)
            self.chapter = int(chapter[0]) if chapter and self.book else 0
            if self.chapter:
                if len(self.chapters) >= MAX_FACTS:
                    raise AnalysisRefusedError(
                        "Too many USFM chapters for an analysis report"
                    )
                self.chapters.setdefault((self.book, self.chapter), Chapter())
                self.books[self.book][self.chapter] += 1
            else:
                self.unread["c"] += 1
        elif marker == "v":
            verse = _VERSE.match(text, offset)
            chapter_facts = self.chapters.get((self.book, self.chapter))
            if not verse or chapter_facts is None or not chapter_facts.add(verse):
                self.unread["v"] += 1


def _usfm(data: bytes, file_index: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return {"inspection": "unreadable_utf8"}, []
    usfm = Usfm()
    for match in _MARKER.finditer(text):
        marker, close = match.groups()
        usfm.markup[marker + close] += 1
        if len(usfm.markup) > 512:
            raise AnalysisRefusedError(
                "Too many USFM markup kinds for an analysis report"
            )
        if not close and marker in ("id", "c", "v"):
            offset = match.end()
            while offset < len(text) and text[offset] in " \t":
                offset += 1
            usfm.opening(marker, text, offset)
    books = {}
    for book, chapters in sorted(usfm.books.items()):
        coverage = _coverage(set(chapters))
        books[book] = {
            "chapters": coverage["ranges"],
            "gaps": coverage["gaps"],
            "repeats": {
                str(number): count for number, count in chapters.items() if count > 1
            },
        }
    return (
        {
            "inspection": "usfm",
            "books": books,
            "markup": dict(usfm.markup),
            "unread": dict(usfm.unread) or ({"id": 1} if not usfm.books else {}),
        },
        [
            {"file": file_index, "book": book, "chapter": chapter, **facts.facts()}
            for (book, chapter), facts in sorted(usfm.chapters.items())
        ],
    )


def _safe_entry(info: ZipInfo) -> bool:
    name = info.orig_filename
    parts = name.rstrip("/").split("/")
    mode = stat.S_IFMT(info.external_attr >> 16)
    return (
        0 < len(name) <= 240
        and all(part not in ("", ".", "..") for part in parts)
        and not any(char in name for char in "\\:")
        and name.isprintable()
        and mode in (0, stat.S_IFREG, stat.S_IFDIR)
        and info.compress_type in (ZIP_STORED, ZIP_DEFLATED)
        and not info.flag_bits & 1
    )


def _members(data: bytes):
    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or not all(map(_safe_entry, entries)):
            raise AnalysisRefusedError("ZIP has too many entries or an unsafe entry")
        files = [entry for entry in entries if not entry.is_dir()]
        if len({entry.filename for entry in files}) != len(files):
            raise AnalysisRefusedError("ZIP contains duplicate file paths")
        if sum(entry.file_size for entry in files) > MAX_ORIGINAL_BYTES:
            raise AnalysisRefusedError("ZIP exceeds the unpacked byte limit")
        for entry in sorted(files, key=lambda item: item.filename):
            with archive.open(entry) as member:
                content = member.read(entry.file_size + 1)
            if len(content) != entry.file_size:
                raise AnalysisRefusedError(
                    "ZIP entry size does not match its declaration"
                )
            yield entry.filename, content


def inspect_original(data: bytes, name: str) -> dict[str, Any]:
    """Record file metadata and USFM references without reading outside these bytes."""
    if len(data) > MAX_ORIGINAL_BYTES:
        raise AnalysisRefusedError("Original exceeds the analysis byte limit")
    zipped = is_zipfile(BytesIO(data)) or PurePosixPath(name).suffix.lower() == ".zip"
    members = _members(data) if zipped else iter([(name, data)])
    facts: list[dict[str, Any]] = []
    try:
        for index, (path, content) in enumerate(members):
            details, chapters = (
                _usfm(content, index)
                if PurePosixPath(path).suffix.lower() in (".usfm", ".sfm")
                else ({"inspection": "unsupported_format"}, [])
            )
            facts.append(
                {
                    "file": index,
                    "path": path,
                    "byte_count": len(content),
                    "sha256": _digest(content),
                    **details,
                }
            )
            facts.extend(chapters)
            if len(facts) > MAX_FACTS:
                raise AnalysisRefusedError("Too many facts for an analysis report")
    except (BadZipFile, zlib.error, NotImplementedError, RuntimeError, OSError):
        raise AnalysisRefusedError("ZIP cannot be read in a supported format") from None
    return {
        "method": METHOD,
        "input_sha256": _digest(data),
        "input_byte_count": len(data),
        "format": "zip" if zipped else "file",
        "facts": facts,
    }


def save_report(data: bytes, name: str, storage: Any) -> dict[str, Any]:
    """Save the deterministic private report and return its immutable reference."""
    report = inspect_original(data, name)
    separators = (",", ":")
    if any(
        len(json.dumps(fact, separators=separators)) > MAX_FACT_BYTES
        for fact in report["facts"]
    ):
        raise AnalysisRefusedError("An analysis report entry exceeds its byte limit")
    payload = json.dumps(report, sort_keys=True, separators=separators).encode()
    if len(payload) > MAX_REPORT_BYTES:
        raise AnalysisRefusedError("Analysis report exceeds its byte limit")
    digest = _digest(payload)
    storage.put_blob(f"analysis-reports/{digest}.json", payload)
    return {
        "artifact_id": f"analysis:{digest[:32]}",
        "sha256": digest,
        "byte_count": len(payload),
    }

"""Read Open Scriptures BDB articles and its separate lexical index.

Keep native article IDs and the source's XML structure. Index cross-references
are source values, not inferred one-to-one mappings or merged lexicon entries.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from xml.etree import ElementTree as ET

from ...prepare.records import RecordError

_NS = 'http://openscriptures.github.com/morphhb/namespace'
_Q = '{' + _NS + '}'
_COMMIT = re.compile(r'[0-9a-f]{40}')
_LANG = '{http://www.w3.org/XML/1998/namespace}lang'


@dataclass(frozen=True)
class BDBEntry:
    work: str
    edition: str
    entry_id: str
    native_id: str
    part_id: str
    language: str
    section_id: str
    xml: str


@dataclass(frozen=True)
class LexicalIndexEntry:
    native_id: str
    language: str
    xml: str
    # A source may omit any one of these values; retain each xref separately.
    references: tuple[tuple[str | None, str | None, str | None, str | None], ...]


def _root(original: bytes | str, expected: str) -> ET.Element:
    try:
        root = ET.fromstring(original)
    except (ET.ParseError, ValueError, TypeError) as error:
        raise RecordError('Invalid Open Scriptures XML') from error
    if root.tag != _Q + expected:
        raise RecordError('Unexpected Open Scriptures XML root')
    return root


def _id(element: ET.Element, seen: set[str]) -> str:
    native_id = element.get('id')
    if not native_id or native_id in seen:
        raise RecordError('Missing or duplicate Open Scriptures entry ID')
    seen.add(native_id)
    return native_id


def read_bdb(original: bytes | str, *, commit: str) -> tuple[BDBEntry, ...]:
    """Return article XML and native IDs without normalizing the source text."""
    if not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise RecordError('Recipe does not declare a pinned Open Scriptures commit')
    root = _root(original, 'lexicon')
    entries: list[BDBEntry] = []
    seen: set[str] = set()
    for part in root.findall(_Q + 'part'):
        for section in part.findall(_Q + 'section'):
            for article in section.findall(_Q + 'entry'):
                native_id = _id(article, seen)
                entries.append(BDBEntry(
                    'oshb-bdb', f'HebrewLexicon:{commit}', f'oshb-bdb:{commit}:{native_id}',
                    native_id, part.get('id', ''), part.get(_LANG, ''),
                    section.get('id', ''), ET.tostring(article, encoding='unicode')))
    if not entries:
        raise RecordError('Open Scriptures BDB has no entries')
    return tuple(entries)


def read_lexical_index(original: bytes | str) -> tuple[LexicalIndexEntry, ...]:
    """Return source index entries and each unmodified cross-reference value."""
    root = _root(original, 'index')
    entries: list[LexicalIndexEntry] = []
    seen: set[str] = set()
    for part in root.findall(_Q + 'part'):
        for entry in part.findall(_Q + 'entry'):
            native_id = _id(entry, seen)
            refs = tuple((x.get('bdb'), x.get('strong'), x.get('aug'), x.get('twot'))
                         for x in entry.findall(_Q + 'xref'))
            entries.append(LexicalIndexEntry(
                native_id, part.get(_LANG, ''), ET.tostring(entry, encoding='unicode'), refs))
    if not entries:
        raise RecordError('Open Scriptures lexical index has no entries')
    return tuple(entries)

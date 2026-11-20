"""Read STEP's two TFLSJ files as one LSJ work, without conflating homonyms.

Each source row keeps its native dStrong article identity; eStrong is only a
lookup/link key. The original LSJ meaning, including markup and references,
is retained verbatim. This reader does not acquire, prepare or publish data.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal

from ...prepare.records import RecordError
from .commit import COMMIT_PATTERN

LSJPart = Literal['0-5624', 'extra']
_PARTS = ('0-5624', 'extra')
_HEADER = 'eStrong\tdStrong\tuStrong\tGreek\tTransliteration\tMorph\tGloss\tLSJ Meaning'
_ESTRONG = re.compile(r'G\d{4,5}[a-z]?')
_DSTRONG = re.compile(r'(G\d{4,5}[A-Za-z]?)(?:\s+(.*))?')


@dataclass(frozen=True)
class LSJEntry:
    work: str
    edition: str
    entry_id: str                  # Work + pinned edition + native dStrong
    source_part: LSJPart           # Which original contains the entry
    extended_strongs: str         # Lookup/link key only; homonyms may share it
    disambiguated_strongs: str    # Native article key
    disambiguation: str           # Any source relationship note in dStrong
    unified_strongs: str          # Source value, including composite links
    lemma: str
    transliteration: str
    morphology: str
    gloss: str
    meaning: str                  # Exact source HTML and references; may be empty


def read_lsj(original: bytes | str, *, part: LSJPart, commit: str) -> tuple[LSJEntry, ...]:
    """Read one B1-acquired TFLSJ original; pass commit from recipe parameters.

    Both parts belong to the same LSJ work and edition. Do not collapse entries
    with shared extended Strong's numbers or substitute glosses for empty meanings.
    """
    if part not in _PARTS:
        raise RecordError('Unknown TFLSJ source part')
    if not isinstance(commit, str) or not COMMIT_PATTERN.fullmatch(commit):
        raise RecordError('Recipe does not declare a pinned STEP commit')
    try:
        text = original.decode('utf-8-sig') if isinstance(original, bytes) else original.lstrip('\ufeff')
    except UnicodeError as error:
        raise RecordError('TFLSJ original is not UTF-8') from error
    lines = text.splitlines()
    expected_title = f'TFLSJ - Translators Formatted full LSJ Bible lexicon {part} - STEPBible.org CC BY'
    if not lines or lines[0] != expected_title:
        raise RecordError(f'Expected TFLSJ {part} original')
    try:
        start = lines.index(_HEADER)
    except ValueError:
        raise RecordError('TFLSJ original has no declared eight-column header') from None

    found: list[LSJEntry] = []
    seen: set[str] = set()
    edition = f'STEPBible-Data:{commit}'
    for number, line in enumerate(lines[start + 1:], start=start + 2):
        if not line.strip() or line.startswith('='):
            continue
        fields = line.split('\t')
        if len(fields) != 8:
            raise RecordError(f'Line {number}: not an eight-column TFLSJ entry')
        extended, disambiguated, unified, lemma, transliteration, morphology, gloss, meaning = fields
        match = _DSTRONG.fullmatch(disambiguated.strip())
        if not _ESTRONG.fullmatch(extended) or match is None:
            raise RecordError(f'Line {number}: invalid TFLSJ Strong numbers')
        native_id = match[1]
        if native_id in seen:
            raise RecordError(f'Line {number}: duplicate native TFLSJ entry {native_id}')
        seen.add(native_id)
        found.append(LSJEntry(
            'TFLSJ', edition, f'tflsj:{commit}:{native_id}', part,
            extended, native_id, match[2] or '', unified,
            lemma, transliteration, morphology, gloss, meaning))
    if not found:
        raise RecordError('TFLSJ original contains no entries')
    return tuple(found)

"""Read the pinned STEP TBESH/TBESG tab-separated lexicons without merging entries.

Each native dStrong identifies an entry within its own STEP lexicon work and
pinned edition. The extended Strong's number is only a lookup/link key.
TBESH's `Meaning` field has its own Online Bible permission request, so this
reader deliberately never returns that field; its STEP gloss is usable.
"""
from __future__ import annotations

from dataclasses import dataclass
import re

from ...prepare.records import RecordError
from .format import Language

SOURCE_COMMIT = '5de0a47f35f0fc13dfe1430d104e5db8a4285f9c'
EDITION = f'STEPBible-Data:{SOURCE_COMMIT}'
_WORKS = {
    'hebrew': ('TBESH', 'H', 'eStrong#', 'Hebrew'),
    'greek': ('TBESG', 'G', 'eStrong', 'Greek'),
}
_EXTENDED = re.compile(r'[HG]\d{4,5}[a-z]?')
_DISAMBIGUATED = re.compile(r'([HG]\d{4,5}[A-Za-z]?)(?:\s+(.*))?')


@dataclass(frozen=True)
class LexiconEntry:
    work: str
    edition: str
    entry_id: str                    # Work + edition + native dStrong, never eStrong
    extended_strongs: str            # Source lookup/link key (may have homonyms)
    disambiguated_strongs: str       # Native article identifier in this lexicon
    disambiguation: str              # Source relation note from the dStrong column
    unified_strongs: str            # Keep STEP's raw value; may describe several links
    lemma: str
    transliteration: str
    morphology: str
    gloss: str
    definition: str | None           # TBESH Meaning excluded pending permission


def read_lexicon(original: bytes | str, language: Language) -> tuple[LexiconEntry, ...]:
    """Read each native entry in source order, preserving homonyms as separate rows.

    Caller provides the acquired B1 original. The reader does not fetch, write,
    prepare, index or publish any data. Greek definitions keep source markup.
    """
    if language not in _WORKS:
        raise RecordError('Unknown STEP lexicon language')
    work, prefix, first_header, form_header = _WORKS[language]
    try:
        text = original.decode('utf-8-sig') if isinstance(original, bytes) else original.lstrip('\ufeff')
    except UnicodeError as error:
        raise RecordError('STEP lexicon original is not UTF-8') from error
    lines = text.splitlines()
    if not lines or not lines[0].startswith(work + ' -'):
        raise RecordError(f'Expected {work} lexicon original')

    header = (first_header, 'dStrong', 'uStrong', form_header, 'Transliteration', 'Morph', 'Gloss')
    start = next((n for n, line in enumerate(lines)
                  if tuple(line.split('\t')[:7]) == header), None)
    if start is None:
        raise RecordError(f'{work} lexicon has no declared eight-column header')

    entries: list[LexiconEntry] = []
    seen: set[str] = set()
    for line_number, line in enumerate(lines[start + 1:], start=start + 2):
        if not line.strip() or line.startswith('==='):
            continue
        fields = line.split('\t')
        if len(fields) != 8:
            raise RecordError(f'Line {line_number}: not an eight-column {work} entry')
        e_strongs, d_field, unified, lemma, transliteration, morphology, gloss, definition = fields
        d_match = _DISAMBIGUATED.fullmatch(d_field.strip())
        if (not _EXTENDED.fullmatch(e_strongs) or not e_strongs.startswith(prefix)
                or d_match is None or not d_match[1].startswith(prefix)):
            raise RecordError(f'Line {line_number}: invalid STEP Strong numbers')
        native_id = d_match[1]
        if native_id in seen:
            raise RecordError(f'Line {line_number}: duplicate native {work} entry {native_id}')
        seen.add(native_id)
        entries.append(LexiconEntry(
            work, EDITION, f'{work.lower()}:{SOURCE_COMMIT}:{native_id}',
            e_strongs, native_id, d_match[2] or '', unified,
            lemma, transliteration, morphology, gloss,
            definition if language == 'greek' else None))
    if not entries:
        raise RecordError(f'{work} lexicon has no entries')
    return tuple(entries)

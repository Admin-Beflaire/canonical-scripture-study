"""Compare STEP's English/Hebrew exception summary with tagged-text markers.

This is a diagnostic, not a mapping producer or a check of the selected release.
Only the explicitly listed Hebrew/English summary is interpreted. Other tables,
subverse boundaries and absent or ambiguous counterparts are not inferred.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable

from ...prepare.records import RecordError
from .format import TaggedWord

_HEADER = 'English (NRSV, ESV, KJV etc)\tHebrew MT'
_BOOK = r'(?:[1-3][A-Z][a-z]|[A-Z][a-z]{2})'
_REF = re.compile(rf'(?P<book>{_BOOK})\.(?P<chapter>\d+):(?P<verse>\d+)')
_PART = re.compile(rf'(?:(?P<book>{_BOOK})\.)?(?:(?P<chapter>\d+):)?(?P<verse>\d+)')


@dataclass(frozen=True)
class ExceptionRow:
    reader: str
    native: tuple[str, ...]
    limitation: str | None = None


def _targets(cell: str, book: str, chapter: int) -> tuple[str, ...] | None:
    """Expand only unambiguous whole-verse lists; never discard subverse qualifiers."""
    result = []
    for part in re.split(r'[,;]', cell):
        match = _PART.fullmatch(part.strip())
        if not match:
            return None
        book = match['book'] or book
        chapter = int(match['chapter'] or chapter)
        result.append(f'{book}.{chapter}.{int(match["verse"])}')
    return tuple(dict.fromkeys(result))


def read_exceptions(data: bytes) -> tuple[ExceptionRow, ...]:
    try:
        lines = data.decode('utf-8-sig').splitlines()
    except UnicodeDecodeError as error:
        raise RecordError('TVTMS original is not UTF-8') from error
    headers = [i for i, line in enumerate(lines) if line.startswith(_HEADER)]
    if len(headers) != 1:
        raise RecordError('TVTMS English/Hebrew summary header is missing or ambiguous')
    result = []
    started = False
    for line in lines[headers[0] + 1:]:
        if not line.strip():
            if started:
                break
            continue
        fields = line.split('\t')
        if fields[0].startswith("'="):
            continue
        started = True
        if len(fields) < 2 or not (match := _REF.fullmatch(fields[0].strip().lstrip('*'))):
            raise RecordError('Unrecognised TVTMS English/Hebrew summary row')
        book, chapter = match['book'], int(match['chapter'])
        reader = f'{book}.{chapter}.{int(match["verse"])}'
        native = _targets(fields[1].strip(), book, chapter) if fields[1].strip() else None
        result.append(ExceptionRow(reader, native or (), None if native else 'missing or non-whole-verse target'))
    if not result:
        raise RecordError('TVTMS English/Hebrew summary is empty')
    if len({row.reader for row in result}) != len(result):
        raise RecordError('Duplicate TVTMS reader reference in summary')
    return tuple(result)


def compare_exceptions(rows: Iterable[ExceptionRow], words: Iterable[TaggedWord], book: str) -> list[dict]:
    """Report explicit pairs only; an absent word marker is unresolved, not a mismatch."""
    observed: dict[str, set[str]] = {}
    for word in words:
        if word.book == book:
            observed.setdefault(word.reference, set()).add(word.unit_id)
    if not observed:
        raise RecordError(f'Book {book} is not present in the tagged source')
    report = []
    for row in rows:
        if not row.reader.startswith(book + '.'):
            continue
        actual = sorted(observed.get(row.reader, set()))
        if row.limitation:
            status = 'unresolved'
        elif not actual:
            status = 'not_observed'
        elif set(row.native) == set(actual):
            status = 'match'
        else:
            status = 'difference'
        report.append({'reader': row.reader, 'expected_native': list(row.native),
                       'observed_native': actual, 'status': status, 'limitation': row.limitation})
    return report

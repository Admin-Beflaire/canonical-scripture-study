"""Read STEP's TEHMC/TEGMC explanations without changing their grammar claims.

Both originals contain brief lexicon codes (tab-separated Code/Example/Meaning)
and full tagged-word codes (dollar-separated groups of code, grammar, meaning,
example). The single legacy TEGMC spreadsheet fragment is handled in place.
No acquisition, preparation, or Study integration happens here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...prepare.records import RecordError
from .format import Language


@dataclass(frozen=True)
class MorphologyExplanation:
    code: str
    kind: Literal['brief', 'full']
    grammar: str
    meaning: str
    example: str


def _unquote(text: str) -> str:
    text = text.strip()
    return text[1:-1] if len(text) >= 2 and text[0] == text[-1] == '"' and '"' not in text[1:-1] else text


def read_morphology(original: bytes | str, language: Language) -> dict[str, tuple[MorphologyExplanation, ...]]:  # noqa: C901
    """Return all explanations under their exact STEP code, retaining repeated codes.

    Missing codes have no entry; no grammar is inferred from code characters.
    The caller must supply the corresponding pinned, acquired original bytes.
    """
    if language not in ('hebrew', 'greek'):
        raise RecordError('Unknown morphology language')
    try:
        text = original.decode('utf-8-sig') if isinstance(original, bytes) else original.lstrip('\ufeff')
    except UnicodeError as error:
        raise RecordError('Morphology original is not UTF-8') from error
    lines = text.splitlines()
    title = 'TEHMC' if language == 'hebrew' else 'TEGMC'
    if not lines or not lines[0].startswith(title + ' -'):
        raise RecordError(f'Expected {title} morphology original')
    try:
        brief_start = next(i for i, line in enumerate(lines) if line.startswith('Code\tExample in English\tMeaning'))
        full_start = next(i for i, line in enumerate(lines) if line.strip() == 'FULL MORPHOLOGY CODES:')
        first_group = next(i for i in range(full_start + 1, len(lines)) if lines[i].strip() == '$')
    except StopIteration:
        raise RecordError('Morphology original has no declared code sections') from None
    if not brief_start < full_start < first_group:
        raise RecordError('Morphology code sections are out of order')

    found: dict[str, list[MorphologyExplanation]] = {}

    def add(item: MorphologyExplanation) -> None:
        if not item.code or not item.grammar:
            raise RecordError('Morphology code has no explanation')
        found.setdefault(item.code, []).append(item)

    for line in lines[brief_start + 1:full_start]:
        # Separator line and unstructured explanatory headings are not code rows.
        if not line or line[0].isspace() or '\t' not in line or line.startswith('='):
            continue
        parts = line.split('\t')
        if len(parts) >= 3 and parts[0].strip() and parts[2].strip():
            add(MorphologyExplanation(parts[0].strip(), 'brief', parts[2].strip(), '', parts[1].strip()))

    def group(rows: list[str]) -> None:
        if not rows:
            return
        first = rows[0].split('\t', 1)
        if len(first) != 2 or not first[1].strip().startswith('Function=') or len(rows) < 4:
            raise RecordError(f'Malformed {title} full morphology group: {rows[0][:40]}')
        if not all(row.startswith('\t') for row in rows[1:4]):
            raise RecordError(f'Malformed {title} grammar explanation for {first[0]}')
        add(MorphologyExplanation(first[0].strip(), 'full', _unquote(rows[1]),
                                  _unquote(rows[2]), _unquote(rows[3])))
        # One TEGMC code (V-PMO-3P) was left in its five-row spreadsheet format,
        # immediately after V-PMO-1S without its own '$' separator. Its -5 row
        # still contains a complete grammar, meaning and example.
        for row in rows[4:]:
            parts = row.split('\t')
            if len(parts) >= 7 and parts[1] == '-5':
                add(MorphologyExplanation(parts[0].strip(), 'full', _unquote(parts[6]),
                                          _unquote(parts[2]), _unquote(parts[4])))

    pending: list[str] = []
    for line in lines[first_group + 1:]:
        if line.strip() == '$':
            group(pending)
            pending = []
        elif line.strip():
            pending.append(line)
    group(pending)
    if not found:
        raise RecordError('Morphology original contains no code explanations')
    return {code: tuple(items) for code, items in found.items()}

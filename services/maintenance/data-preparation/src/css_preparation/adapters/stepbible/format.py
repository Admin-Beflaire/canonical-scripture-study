"""Reader for STEPBible's tagged word-per-line text (TAHOT Hebrew OT, TAGNT Greek NT).

Only the word rows are data: `Ref=Type<TAB>word<TAB>...`, one row per original-language
word in native order. Header notices, interlinear summary lines (`# ...`, `#_...`) and the
column headings are skipped. The reader does not change any column; `native_form` states
the one fixed rule that turns a word cell into running-text wording.

Reference forms (as declared in the files' field descriptions):
- TAHOT `Gen.31.55(32.1)#01=L`: English (NRSV) reference, then the Hebrew reference in round
  brackets when it differs. The Hebrew reference is the native verse.
- TAGNT `Mat.1.1#01=NKO`: NRSV reference, then NA `( )`, KJV `[ ]` or other `{ }` references
  when they differ. The Nestle-Aland reference is the native verse of the declared base text.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable, Iterator, Literal

Language = Literal['hebrew', 'greek']
COLUMNS = 17
_BOOK = r'(?:[1-3][A-Z][a-z]|[A-Z][a-z]{2})'
_REF = re.compile(
    rf'(?P<book>{_BOOK})\.(?P<chapter>\d{{1,3}})\.(?P<verse>\d{{1,3}})'
    r'(?:\((?P<round>\d{1,3}\.\d{1,3})\))?(?:\[(?P<square>\d{1,3}\.\d{1,3})\])?(?:\{(?P<curly>\d{1,3}\.\d{1,3})\})?'
    r'#(?P<number>\d{1,4})=(?P<type>[A-Za-z()+]{1,24})')
_ROW = re.compile(rf'{_BOOK}\.\d')
_GREEK_CELL = re.compile(r'(?P<form>.*?) \((?P<translit>[^()]*)\)')
# TAHOT word cells use `/` between morphemes and `\` before punctuation; neither is wording.
_HEBREW_MARKUP = str.maketrans('', '', '/\\')


class FormatError(ValueError):
    """The file does not follow the declared STEPBible tagged-text layout."""


@dataclass(frozen=True)
class TaggedWord:
    line: int                 # 1-based line in the file, for diagnostics only
    book: str
    unit_id: str              # native verse, e.g. 'Gen.32.1'
    reference: str            # English/NRSV verse as printed first, e.g. 'Gen.31.55'
    other_references: tuple[tuple[str, str], ...]  # (bracket, 'c.v') pairs as printed
    number: int               # word number within the native verse
    text_type: str            # e.g. 'L', 'Q(K)', 'X', 'NKO', 'N(k)O'
    cells: tuple[str, ...]    # every column after the reference, unchanged

    @property
    def cell(self) -> str:
        return self.cells[0]


def _verse(book: str, chapter_verse: str) -> str:
    chapter, verse = chapter_verse.split('.')
    return f'{book}.{int(chapter)}.{int(verse)}'


def read_words(lines: Iterable[str], language: Language) -> Iterator[TaggedWord]:
    """Yield word rows in file order. Any malformed word row stops the read."""
    if language not in ('hebrew', 'greek'):
        raise FormatError('Unknown STEPBible language')
    native_bracket = 'round'
    for number, line in enumerate(lines, start=1):
        line = line.rstrip('\n').rstrip('\r')
        if not _ROW.match(line):
            continue
        cells = line.split('\t')
        match = _REF.fullmatch(cells[0])
        if match is None or len(cells) != COLUMNS:
            raise FormatError(f'Line {number}: not a word row of the declared layout')
        book = match['book']
        english = f"{book}.{int(match['chapter'])}.{int(match['verse'])}"
        native = _verse(book, match[native_bracket]) if match[native_bracket] else english
        if language == 'hebrew' and (match['square'] or match['curly']):
            raise FormatError(f'Line {number}: TAHOT references use round brackets only')
        others = tuple((name, match[name]) for name in ('round', 'square', 'curly') if match[name])
        yield TaggedWord(number, book, native, english, others, int(match['number']), match['type'],
                         tuple(cells[1:]))


def native_form(word: TaggedWord, language: Language) -> str:
    """The word's running-text wording.

    Hebrew: the Hebrew cell without STEPBible's `/` and `\\` separators, `//` (a word break
    inside one row) becoming a space. Greek: the Greek
    cell before its ` (transliteration)`. Surrounding spaces are not wording.
    """
    if language == 'hebrew':
        # `//` divides two words held in one row (for example a Qere of two words): a space.
        return word.cell.replace('//', ' ').translate(_HEBREW_MARKUP).strip()
    match = _GREEK_CELL.fullmatch(word.cell)
    if match is None:
        raise FormatError(f'Line {word.line}: Greek cell has no transliteration')
    return match['form'].strip()


MAQAF = '־'


def join_forms(forms: Iterable[str], language: Language) -> tuple[str, tuple[tuple[int, int], ...]]:
    """Join word forms into one verse text; return it with each word's scalar range.

    Words are separated by one space, except that a Hebrew word ending in maqaf joins the
    next word directly, as printed. Empty forms (a Qere with no wording) take no space.
    """
    text, ranges = '', []
    for form in forms:
        if form and text and not (language == 'hebrew' and text.endswith(MAQAF)):
            text += ' '
        start = len(text)
        text += form
        ranges.append((start, len(text)))
    return text, tuple(ranges)


_TYPE_LETTERS = re.compile(r'\([^)]*\)')


ALL_GREEK_EDITIONS = frozenset(('NA28', 'NA27', 'Tyn', 'SBL', 'WH', 'Treg', 'TR', 'Byz'))


def editions_differ(word: TaggedWord) -> bool:
    """Is the word missing from any edition, or placed elsewhere in one (`TR«4`)?"""
    return set(greek_editions(word)) != ALL_GREEK_EDITIONS or any(mark in word.cells[4] for mark in '«»')


def greek_editions(word: TaggedWord) -> tuple[str, ...]:
    """Edition names from the TAGNT editions cell, without displacement notes (`TR«4`)."""
    names = []
    for part in word.cells[4].split('+'):
        name = re.split(r'[«»]', part.strip(), maxsplit=1)[0].strip()
        if name:
            names.append(name)
    return tuple(names)


def outer_type_letters(text_type: str) -> str:
    """Type letters outside brackets (bracketed letters name variants)."""
    return _TYPE_LETTERS.sub('', text_type)

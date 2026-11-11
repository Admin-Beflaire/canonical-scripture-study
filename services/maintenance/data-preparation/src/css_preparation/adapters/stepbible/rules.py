"""Named search rules and word analyses for the STEPBible tagged texts.

Each rule has a fixed version name recorded in the output's reuse parameters; changing a
rule's behaviour needs a new name. The rules choose search keys only: stored wording is
never changed.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

from ...indexes.source import TextRules
from ...indexes.word import AnalysisAlternative
from .format import Language, TaggedWord

# Hebrew letters, points, cantillation, dagesh/shin/sin dots and qamats qatan; not maqaf
# (U+05BE), paseq (U+05C0), sof pasuq (U+05C3) or nun hafukha (U+05C6).
_HEBREW_WORD = re.compile('[\u05d0-\u05ea\u05f0-\u05f2\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7]+')
# Petuchah and setumah paragraph markers stand alone in the wording; they are not words.
_PARAGRAPH_MARKERS = frozenset(('\u05e4', '\u05e1'))
_HEBREW_UNSEARCHED = re.compile('[\u0591-\u05af\u05bd\u05c4\u05c5]')  # cantillation, meteg, puncta
# Greek letters (precomposed or with combining marks) and the elision mark.
_GREEK_WORD = re.compile('(?:[^\\W\\d_]|[\u0300-\u036f\u1fbd\u1fbf\u2019])+')
_ELISION = str.maketrans({'\u1fbd': '\u2019', '\u1fbf': '\u2019', "'": '\u2019'})


def _hebrew_tokens(text: str) -> Iterable[tuple[int, int]]:
    for match in _HEBREW_WORD.finditer(text):
        if match.group() not in _PARAGRAPH_MARKERS:
            yield match.span()


def _hebrew_key(form: str) -> str:
    return unicodedata.normalize('NFC', _HEBREW_UNSEARCHED.sub('', form))


def _greek_tokens(text: str) -> Iterable[tuple[int, int]]:
    for match in _GREEK_WORD.finditer(text):
        yield match.span()


def _greek_key(form: str) -> str:
    bare = ''.join(c for c in unicodedata.normalize('NFD', form) if unicodedata.category(c) != 'Mn')
    return unicodedata.normalize('NFC', bare.casefold().translate(_ELISION))


RULES = {
    'hebrew': TextRules('stepbible-hebrew-words/1', 'stepbible-hebrew-pointed-no-accents/1',
                        _hebrew_tokens, _hebrew_key),
    'greek': TextRules('stepbible-greek-words/1', 'stepbible-greek-folded/1', _greek_tokens, _greek_key),
}
GRAMMAR_KEY_VERSION = 'stepbible-morphology-code/1'

_HEBREW_TAG = re.compile(r'\{?(H\d{4,5}[A-Za-z]?)\}?\+?')
_GREEK_TAG = re.compile(r'(G\d{4,5}[A-Za-z]?)=([A-Z0-9][A-Za-z0-9-]*)')
_LANGUAGES = {'H': 'hebrew', 'A': 'aramaic'}
# Punctuation pseudo-tags (H9014-H9019: maqaf, paseq, sof pasuq, petuchah, setumah, nun hafukha).
_PUNCTUATION = frozenset(f'H90{n}' for n in range(14, 20))


def _hebrew_parts(word: TaggedWord) -> list[tuple[str, dict[str, str]]]:
    """(lemma, grammar) per tagged morpheme, aligning the dStrongs and Grammar cells.

    `/` separates morphemes, `//` a second word in the same row, and `\\` precedes a
    punctuation tag that has no morphology. The first grammar code carries the language
    letter (H Hebrew, A Aramaic) for the whole row.
    """
    tags = word.cells[3].split('/') if word.cells[3] else []
    codes = word.cells[4].split('/') if word.cells[4] else []
    if not codes or codes[0][:1] not in _LANGUAGES:
        return []
    language = _LANGUAGES[codes[0][0]]
    codes[0] = codes[0][1:]
    pairs = []
    aligned = len(tags) == len(codes)
    for index, tag in enumerate(tags):
        tag = tag.strip().split('\\')[0]
        match = _HEBREW_TAG.fullmatch(tag)
        if match is None or match[1] in _PUNCTUATION:
            continue
        grammar = {'language': language, 'role': 'root' if tag.startswith('{') else 'affix'}
        if aligned and codes[index]:
            grammar['morphology'] = codes[index]
        pairs.append((match[1], grammar))
    return pairs


def _greek_parts(word: TaggedWord) -> list[tuple[str, dict[str, str]]]:
    pairs = []
    for piece in word.cells[2].split(' + '):
        match = _GREEK_TAG.fullmatch(piece.strip())
        if match is None:
            return []
        pairs.append((match[1], {'language': 'greek', 'morphology': match[2]}))
    return pairs


def analyses(word: TaggedWord, language: Language, occurrence_id: str, analysis_revision_id: str,
             provider: str, basis: str) -> tuple[AnalysisAlternative, ...]:
    """The row's attributed analyses: one per tagged morpheme (Hebrew) or component (Greek).

    A Hebrew word with a prefix, or a Greek crasis such as κἀγώ, has several parts; each
    is one attributed analysis with its own lemma, so searching any of the lemmas finds it.
    """
    parts = _hebrew_parts(word) if language == 'hebrew' else _greek_parts(word)
    return tuple(AnalysisAlternative(f'{occurrence_id}:{index + 1}', analysis_revision_id, lemma,
                                     grammar, provider, basis)
                 for index, (lemma, grammar) in enumerate(parts))


def grammar_keys(alternative: AnalysisAlternative) -> tuple[str, ...]:
    code = alternative.grammar.get('morphology')
    return (f"grammar:{alternative.grammar['language']}:{code}",) if code else ()

"""Case- and Unicode-exact word keys for the supported English text."""

from collections.abc import Iterator
from unicodedata import category

from .source import TextRules

AS_WRITTEN = "english-as-written/1"

_JOINERS = frozenset("'’ʼ-‐‑")


def _letter(char: str) -> bool:
    return char not in _JOINERS and category(char).startswith("L")


def english_words(text: str) -> Iterator[tuple[int, int]]:
    index = 0
    while index < len(text):
        if not _letter(text[index]):
            index += 1
            continue
        start = index
        index += 1
        while index < len(text):
            char = text[index]
            if not (
                _letter(char)
                or category(char).startswith("M")
                or (
                    char in _JOINERS
                    and index + 1 < len(text)
                    and _letter(text[index + 1])
                )
            ):
                break
            index += 1
        yield start, index


def _as_written(word: str) -> str:
    return word


ENGLISH_EXACT = TextRules("english-letters/1", AS_WRITTEN, english_words, _as_written)

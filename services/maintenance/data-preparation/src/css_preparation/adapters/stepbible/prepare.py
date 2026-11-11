"""Native evidence, source search and word/lemma/grammar indexes for one STEPBible unit.

A prepare unit is a list of native verses of one book (the recipe sizes it so that one
D1 batch holds its rows). The verse wording is the declared base text joined from the word
rows; nothing is translated, normalised or re-ordered. Readings that are not plain
manuscript transcription are marked:

- TAHOT words of type R (restored) and X (reconstructed from the Septuagint) get their own
  word spans with those reading kinds; Qere words get a word span that says so.
- TAHOT's Ketiv and recorded variants, and TAGNT's words found only in other editions (such as
  the TR) and recorded variants, become attributed annotations on the verse.
- A verse with no base wording (for example a verse absent from NA28) is a gap with its
  other-edition words in an annotation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from ...indexes.files import build_index_files
from ...indexes.source import build_source_postings
from ...indexes.word import WordObservation, build_word_postings
from ...prepare.evidence import AnnotationSpec, NativeText, OutputBasis, SpanSpec, build_evidence
from ...prepare.records import RecordError, RecordSet
from .format import (FormatError, TaggedWord, editions_differ, greek_editions, join_forms, native_form,
                     outer_type_letters, read_words)
from .rules import GRAMMAR_KEY_VERSION, RULES, analyses, grammar_keys
from .source import BOOK_STRIDE, BOOKS, PROVIDER, Component

METHOD_VERSION = 'stepbible-tagged/1'
BASE_EDITION = 'NA28'
MAX_STATEMENTS = 1000      # One D1 batch per unit (runner limit).
PAGE_CAP = 2048
_READING = {'R': 'restored', 'X': 'reconstructed'}


@dataclass(frozen=True)
class Verse:
    unit_id: str
    text: str
    references: tuple[str, ...]                       # English/NRSV verses of its words
    words: tuple[TaggedWord, ...]                     # every row, in file order
    ranges: tuple[tuple[int, int] | None, ...]        # base-text range per row, or None


def read_component(data: bytes, component: Component) -> list[TaggedWord]:
    try:
        text = component.check_original(data).decode('utf-8', errors='strict')
    except UnicodeError as error:
        raise RecordError('Original is not UTF-8') from error
    try:
        return list(read_words(text.splitlines(), component.source.language))
    except FormatError as error:
        raise RecordError(str(error)) from error


def _in_base(word: TaggedWord, component: Component) -> bool:
    if component.source.language == 'greek':
        return BASE_EDITION in greek_editions(word)
    return True


def book_verses(words: Iterable[TaggedWord], component: Component, book: str) -> tuple[Verse, ...]:
    """Every native verse of one book, in file order."""
    language = component.source.language
    grouped: dict[str, list[TaggedWord]] = {}
    for word in words:
        if word.book != book:
            continue
        if word.unit_id in grouped and next(reversed(grouped)) != word.unit_id:
            raise RecordError(f'Verse {word.unit_id} is not contiguous in the file')
        grouped.setdefault(word.unit_id, []).append(word)
    if not grouped:
        raise RecordError(f'Book {book} is not in this component')
    verses = []
    for unit_id, rows in grouped.items():
        base = [_in_base(row, component) for row in rows]
        text, joined = join_forms((native_form(row, language) for row, keep in zip(rows, base) if keep), language)
        ranges, taken = [], iter(joined)
        for keep in base:
            ranges.append(next(taken) if keep else None)
        verses.append(Verse(unit_id, text, tuple(dict.fromkeys(row.reference for row in rows)),
                            tuple(rows), tuple(ranges)))
    return tuple(verses)


def book_text(verses: Sequence[Verse], component: Component, book: str,
              unit_ids: Sequence[str] | None = None) -> NativeText:
    """Native text of a book, or of some of its verses, positioned in the revision's linear order."""
    try:
        start = BOOKS[component.source.key].index(book) * BOOK_STRIDE
    except ValueError:
        raise RecordError(f'Unknown book {book}') from None
    bases, offset = {}, start
    for verse in verses:
        bases[verse.unit_id] = offset
        offset += len(verse.text)
    by_id = {verse.unit_id: verse for verse in verses}
    wanted = list(by_id) if unit_ids is None else list(unit_ids)
    if any(unit not in by_id for unit in wanted):
        raise RecordError('Requested verses are not all in this book')
    return NativeText(component.coordinate_version, tuple((unit, by_id[unit].text) for unit in wanted),
                      order_bases=tuple(bases[unit] for unit in wanted))


def _label(unit_id: str) -> str:
    book, chapter, verse = unit_id.split('.')
    return f'{book} {chapter}:{verse}'


def _variant_entries(verse: Verse, component: Component) -> list[dict[str, Any]]:
    entries = []
    for position, (word, span) in enumerate(zip(verse.words, verse.ranges), start=1):
        meaning, spelling = word.cells[5], word.cells[6]
        entry: dict[str, Any] = {'row': position, 'type': word.text_type}
        if component.source.language == 'greek':
            # The editions cell is kept exactly, with any displacement note (`TR«4`): which
            # editions have the word, and where an edition places it.
            if span is None:
                entry.update(word=native_form(word, 'greek'), editions=word.cells[4],
                             gloss=word.cells[1], tags=word.cells[2])
            elif editions_differ(word):
                entry['editions'] = word.cells[4]
            elif not meaning and not spelling:
                continue
        elif word.text_type == 'L' and not meaning and not spelling:
            continue
        elif span is None or span[0] == span[1]:
            entry['word'] = ''
        if meaning:
            entry['meaning_variants'] = meaning
        if spelling:
            entry['spelling_variants'] = spelling
        entries.append(entry)
    return entries


def evidence_specs(verses: Sequence[Verse], component: Component) -> tuple[list[SpanSpec], list[AnnotationSpec]]:
    spans, notes = [], []
    for verse in verses:
        unit = verse.unit_id
        basis: dict[str, Any] = {'rows': f'{component.source.key.upper()} word rows'}
        if verse.references != (unit,):
            basis['english_references'] = list(verse.references)
        if verse.text:
            spans.append(SpanSpec(unit, 'verse', _label(unit), ((unit, 0, len(verse.text)),), 'extracted', basis))
        else:
            spans.append(SpanSpec(unit, 'verse', _label(unit), ((unit, 0, 0),), 'gap',
                                  {**basis, 'gap': 'No base-text wording in this verse'}))
        if component.source.language == 'hebrew':
            for position, (word, span) in enumerate(zip(verse.words, verse.ranges), start=1):
                letters = outer_type_letters(word.text_type)
                if span is None or span[0] == span[1] or letters.startswith('L'):
                    continue
                kind = _READING.get(letters, 'extracted')
                reading = {'R': 'restored from a parallel passage', 'X': 'reconstructed from the Septuagint',
                           'Q': 'Qere (read) form'}.get(letters, f'text type {word.text_type}')
                spans.append(SpanSpec(f'{unit}#w{position}', 'word', f'{_label(unit)} word {position}',
                                      ((unit, span[0], span[1]),), kind,
                                      {'text_type': word.text_type, 'reading': reading}, parent_key=unit))
        entries = _variant_entries(verse, component)
        if entries:
            notes.append(AnnotationSpec(f'{unit}@variants', unit, 'textual_variants', PROVIDER,
                                        {'columns': 'text type, editions, meaning and spelling variants'},
                                        {'words': entries}))
    return spans, notes


def _observations(text: NativeText, verses: Sequence[Verse], postings: Iterable[dict],
                  component: Component) -> list[WordObservation]:
    language = component.source.language
    rows = {verse.unit_id: verse for verse in verses}
    result = []
    for posting in postings:
        [segment] = posting['native_reference']['segments']
        unit, start, end = segment['unit_id'], segment['start'], segment['end']
        verse = rows[unit]
        owner = [(word, span) for word, span in zip(verse.words, verse.ranges)
                 if span is not None and span[0] <= start and end <= span[1]]
        if len(owner) != 1:
            raise RecordError(f'Token {posting["occurrence_id"]} is not inside exactly one word row')
        word, span = owner[0]
        alternatives = analyses(word, language, posting['occurrence_id'], component.analysis_revision_id,
                                PROVIDER, component.source.analysis_basis, (start - span[0], end - span[0]))
        if alternatives:
            form = text.unit(unit)[start:end]
            result.append(WordObservation(posting['occurrence_id'], f'{language}:{form}', form, alternatives))
    return result


def prepare_unit(data: bytes, component: Component, book: str, unit_ids: Sequence[str]) -> RecordSet:
    """All candidate records for one prepare unit: evidence, then source and word indexes."""
    if not unit_ids or len(set(unit_ids)) != len(unit_ids):
        raise RecordError('A prepare unit needs distinct native verses')
    verses = book_verses(read_component(data, component), component, book)
    text = book_text(verses, component, book, unit_ids)
    chosen = [verse for verse in verses if verse.unit_id in set(unit_ids)]
    revision = component.revision_id
    extent = {'coordinate_version': text.coordinate_version, 'unit_ids': list(unit_ids)}
    spans, notes = evidence_specs(chosen, component)
    evidence_basis = OutputBasis('evidence', (revision,), METHOD_VERSION,
                                 {'d1_body_max_bytes': 0, 'base_text': component.source.base_text}, extent)
    evidence = build_evidence(component.identity(), text, spans, evidence_basis, d1_body_max_bytes=0,
                              annotations=notes)
    rules = RULES[component.source.language]
    rule_names = {'tokenizer_version': rules.tokenizer_version, 'normalization_rule': rules.normalization_rule}
    source_basis = OutputBasis('source_search', (revision,), METHOD_VERSION, rule_names, extent,
                               (evidence_basis.output_id,))
    sources = build_source_postings(text, evidence, source_basis, rules, max_units=len(unit_ids),
                                    max_scalars=BOOK_STRIDE - 1, max_occurrences=200_000,
                                    encoded_page_cap_bytes=PAGE_CAP)
    postings = [row for part in sources for row in part.postings]
    observations = _observations(text, chosen, postings, component)
    word_basis = OutputBasis('word_index', (revision, component.analysis_revision_id), METHOD_VERSION,
                             {**rule_names, 'grammar_key_version': GRAMMAR_KEY_VERSION}, extent,
                             (evidence_basis.output_id,))
    words = build_word_postings(text, sources, observations,
                                {component.analysis_revision_id: frozenset(row['occurrence_id'] for row in postings)},
                                (component.analysis_revision_id,), word_basis, normalize=rules.normalize,
                                grammar_keys=grammar_keys, max_postings=1_000_000, encoded_page_cap_bytes=PAGE_CAP)
    records = RecordSet().merge(evidence)
    for part in (*sources, *words):
        if not part.postings:
            continue  # Nothing to look up (for example a unit of gap verses): no index, no coverage claim.
        records.merge(build_index_files(part, encoded_page_cap_bytes=PAGE_CAP).records)
    if len(records.statements()) > MAX_STATEMENTS:
        raise RecordError('Prepare unit exceeds one D1 batch; the recipe must use smaller units')
    return records

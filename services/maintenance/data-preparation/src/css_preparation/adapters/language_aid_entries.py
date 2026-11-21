"""Adapt reviewed readers to source-attributed preparation entries."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from .stepbible.lexicon import read_lexicon
from .stepbible.lsj import read_lsj
from .stepbible.morphology import read_morphology
from .oshb.bdb import read_bdb, read_lexical_index


@dataclass(frozen=True)
class AidEntry:
    entry_id: str
    work: str
    edition: str
    body: str
    lookup: dict[str, Any]


def step_entries(component: str, original: bytes, *, commit: str) -> list[AidEntry]:
    """Keep source text and lookup metadata separate; never merge homonyms."""
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('A pinned STEP commit is required')
    if component == 'tipnr':
        from .stepbible.tipnr import read_tipnr
        return read_tipnr(original, commit=commit)
    if component in ('tbesh', 'tbesg'):
        language = 'hebrew' if component == 'tbesh' else 'greek'
        return [AidEntry(item.entry_id, item.work, item.edition,
                         item.gloss if language == 'hebrew' else (item.definition or ''),
                         {'extended_strongs': item.extended_strongs,
                          'strong_base': re.match(r'[HG]\d{4,5}', item.extended_strongs).group(),
                          'lemma': item.lemma, 'transliteration': item.transliteration,
                          'morphology': item.morphology, 'gloss': item.gloss,
                          'unified_strongs': item.unified_strongs,
                          'disambiguation': item.disambiguation,
                          'body_field': 'gloss' if language == 'hebrew' else 'definition'})
                for item in read_lexicon(original, language, commit=commit)]
    if component in ('tflsj-0-5624', 'tflsj-extra'):
        part = '0-5624' if component == 'tflsj-0-5624' else 'extra'
        return [AidEntry(item.entry_id, item.work, item.edition, item.meaning,
                         {'extended_strongs': item.extended_strongs,
                          'strong_base': re.match(r'[HG]\d{4,5}', item.extended_strongs).group(),
                          'lemma': item.lemma, 'transliteration': item.transliteration,
                          'morphology': item.morphology, 'gloss': item.gloss,
                          'unified_strongs': item.unified_strongs,
                          'disambiguation': item.disambiguation, 'source_part': item.source_part,
                          'body_field': 'meaning'})
                for item in read_lsj(original, part=part, commit=commit)]
    if component in ('tehmc', 'tegmc'):
        language = 'hebrew' if component == 'tehmc' else 'greek'
        work = component.upper()
        found = read_morphology(original, language)
        return [AidEntry(f'{component}:{commit}:{code}:{i}', work, f'STEPBible-Data:{commit}',
                         item.grammar, {'code': code, 'kind': item.kind, 'meaning': item.meaning,
                                        'example': item.example, 'body_field': 'grammar'})
                for code, values in found.items() for i, item in enumerate(values)]
    raise ValueError('Unknown STEP language-aid component')


def bdb_entries(original: bytes, *, commit: str) -> list[AidEntry]:
    """BDB articles retain their own source and native article IDs."""
    return [AidEntry(item.entry_id, item.work, item.edition, item.xml,
                     {'bdb_id': item.native_id, 'part_id': item.part_id,
                      'section_id': item.section_id, 'language': item.language,
                      'body_field': 'serialized_xml'})
            for item in read_bdb(original, commit=commit)]


def bdb_index_entries(original: bytes, *, commit: str) -> list[AidEntry]:
    """Index entries retain their own source identity and unresolved references."""
    entries = []
    for item in read_lexical_index(original, commit=commit):
        strongs = {strong for _, strong, _, _ in item.references if strong}
        lookup = {'references': item.references, 'language': item.language, 'body_field': 'serialized_xml'}
        if len(strongs) == 1 and next(iter(strongs)).isdigit():
            lookup['strong_base'] = f'H{int(next(iter(strongs))):04d}'
        entries.append(AidEntry(item.entry_id, item.work, item.edition, item.xml, lookup))
    return entries

"""Translate reviewed source readers into preparation entries.

These objects retain source identities and lookup keys. Empty definitions stay
empty and the TBESH restricted Meaning is never read by this layer.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
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


def _body(value: Any) -> str:
    return json.dumps(asdict(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def step_entries(component: str, original: bytes, *, commit: str) -> list[AidEntry]:
    """Return individual source entries without conflating lookup keys."""
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('A pinned STEP commit is required')
    if component in ('tbesh', 'tbesg'):
        language = 'hebrew' if component == 'tbesh' else 'greek'
        return [AidEntry(item.entry_id, item.work, item.edition, _body(item),
                         {'extended_strongs': item.extended_strongs})
                for item in read_lexicon(original, language, commit=commit)]
    if component in ('tflsj-0-5624', 'tflsj-extra'):
        part = '0-5624' if component == 'tflsj-0-5624' else 'extra'
        return [AidEntry(item.entry_id, item.work, item.edition, _body(item),
                         {'extended_strongs': item.extended_strongs})
                for item in read_lsj(original, part=part, commit=commit)]
    if component in ('tehmc', 'tegmc'):
        language = 'hebrew' if component == 'tehmc' else 'greek'
        work = component.upper()
        found = read_morphology(original, language)
        # A code may have several explanations; each retains its own identity.
        return [AidEntry(f'{component}:{commit}:{code}:{i}', work, f'STEPBible-Data:{commit}',
                         _body(item), {'code': code, 'kind': item.kind})
                for code, values in found.items() for i, item in enumerate(values)]
    raise ValueError('Unknown STEP language-aid component')


def bdb_entries(original: bytes, lexical_index: bytes, *, commit: str) -> list[AidEntry]:
    """Keep BDB articles distinct and retain every source-index association."""
    links: dict[str, list[dict[str, Any]]] = {}
    index = read_lexical_index(lexical_index, commit=commit)
    for entry in index:
        for bdb, strong, aug, twot in entry.references:
            if bdb:
                links.setdefault(bdb, []).append({
                    'index_entry_id': entry.entry_id, 'strong': strong,
                    'aug': aug, 'twot': twot,
                })
    articles = [AidEntry(item.entry_id, item.work, item.edition, _body(item),
                         {'bdb_id': item.native_id, 'index_links': links.get(item.native_id, [])})
                for item in read_bdb(original, commit=commit)]
    index_entries = [AidEntry(item.entry_id, item.work, item.edition, _body(item),
                              {'references': item.references}) for item in index]
    return articles + index_entries

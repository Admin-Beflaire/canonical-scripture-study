"""Write the reviewed per-book STEPBible recipes from local copies of the pinned files.

Development tool, run by a writer, never by a workflow:

    python -m css_preparation.adapters.stepbible.recipes COMMIT OUT_DIR \\
        COMPONENT=REPO_PATH=LOCAL_FILE [...]

It reads only verse references from the local files (to size the units) and checks each
file against its declared digest; the recipes it writes hold references, digests and paths,
never source wording. The files themselves stay outside Git.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

from . import CAPABILITIES, INPUT_FORMAT
from .prepare import METHOD_VERSION, book_verses, read_component
from .source import Component

MAX_VERSES = 300           # Keeps one prepare unit's rows within one D1 batch.
MAX_PREPARE_UNITS = 12     # Quality depends on every prepare unit's outputs: at most 64 references.


def manifest_revision(commit: str) -> str:
    return f'stepbible-data:{commit[:12]}'


def book_recipe(component: Component, book: str, unit_ids: list[str]) -> dict[str, Any]:
    parts = -(-len(unit_ids) // MAX_VERSES)
    size = -(-len(unit_ids) // parts)
    groups = [unit_ids[start:start + size] for start in range(0, len(unit_ids), size)]
    if len(groups) > MAX_PREPARE_UNITS:
        raise ValueError(f'{book} needs more than {MAX_PREPARE_UNITS} prepare units')
    coordinates = component.coordinate_version
    recipe_id = f'stepbible-{component.source.key}-{book.lower()}'
    prepare = [{'unit_id': f'prepare-{index:02d}', 'kind': 'prepare',
                'native_extent': {'coordinate_version': coordinates, 'unit_ids': group},
                'depends_on': ['acquire']} for index, group in enumerate(groups, start=1)]
    return {
        'recipe_version': 'preparation-recipe/1', 'id': recipe_id,
        'revision': f'{recipe_id}/{component.commit[:12]}/1',
        'adapter': {'name': 'stepbible-tagged', 'method_version': METHOD_VERSION},
        'input_format': INPUT_FORMAT,
        'parameters': {'source': component.source.key, 'commit': component.commit,
                       'component': component.component, 'path': component.path,
                       'sha256': component.sha256, 'byte_count': component.byte_count},
        'native_extent': {'book': book, 'coordinate_version': coordinates},
        'capabilities': list(CAPABILITIES), 'dependencies': [component.acquisition_id],
        'manifest_revision': manifest_revision(component.commit),
        'units': [{'unit_id': 'acquire', 'kind': 'acquire', 'native_extent': {'component': component.component},
                   'depends_on': []},
                  *prepare,
                  {'unit_id': 'quality', 'kind': 'quality',
                   'native_extent': {'coordinate_version': coordinates, 'unit_ids': unit_ids},
                   'depends_on': [unit['unit_id'] for unit in prepare], 'required_capabilities': list(CAPABILITIES)}],
    }


def dumps(value: dict[str, Any]) -> str:
    """Two-space JSON with each verse list on one line, so diffs stay readable."""
    text = json.dumps(value, ensure_ascii=False, indent=2)
    return re.sub(r'"unit_ids": \[\s*([^\]]*?)\s*\]',
                  lambda match: '"unit_ids": [' + ', '.join(re.split(r',\s*', match[1])) + ']', text) + '\n'


def main(argv: list[str]) -> int:
    commit, out, *specs = argv
    directory = Path(out)
    for spec in specs:
        name, path, local = spec.split('=', 2)
        data = Path(local).read_bytes()
        component = Component.from_parameters({
            'source': name.split('-')[0], 'commit': commit, 'component': name, 'path': path,
            'sha256': hashlib.sha256(data).hexdigest(), 'byte_count': len(data)})
        words = read_component(data, component)
        for book in dict.fromkeys(word.book for word in words):
            units = [verse.unit_id for verse in book_verses(words, component, book)]
            recipe = book_recipe(component, book, units)
            (directory / f"{recipe['id']}.json").write_text(dumps(recipe), encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

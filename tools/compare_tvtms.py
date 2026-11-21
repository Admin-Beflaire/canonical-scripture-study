"""Compare retained TVTMS and TAHOT originals; see --help for limitations."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from css_preparation.adapters.stepbible.prepare import read_component
from css_preparation.adapters.stepbible.source import Component
from css_preparation.adapters.stepbible.tvtms import compare_exceptions, read_exceptions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tvtms', type=Path, required=True, help='retained TVTMS original')
    parser.add_argument('--tvtms-sha256', required=True, help='registered original SHA-256')
    parser.add_argument('--tagged', type=Path, required=True, help='retained TAHOT component original')
    parser.add_argument('--recipe', type=Path, required=True, help='reviewed TAHOT recipe')
    parser.add_argument('--book', required=True, help='STEP book code, e.g. Mal')
    args = parser.parse_args()
    raw = args.tvtms.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.tvtms_sha256:
        parser.error('TVTMS original differs from the registered SHA-256')
    recipe = json.loads(args.recipe.read_text(encoding='utf-8'))
    component = Component.from_parameters(recipe['parameters'])
    if component.source.key != 'tahot':
        parser.error('The TVTMS summary compares English with Hebrew, not Greek')
    words = read_component(args.tagged.read_bytes(), component)
    report = compare_exceptions(read_exceptions(raw), words, args.book)
    print(json.dumps({'tvtms_sha256': digest, 'tagged_sha256': component.sha256, 'book': args.book,
                      'summary': dict(Counter(row['status'] for row in report)), 'rows': report,
                      'limitations': ['Explicit TVTMS English/Hebrew summary only.',
                                      'Tagged markers are checked, not selected release outputs.',
                                      'Unlisted references and subverse boundaries are not checked.']},
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

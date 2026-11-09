"""Synthetic native sources for preparation tests. Not real source material."""
import sqlite3
import unicodedata

from css_preparation.prepare.evidence import (AnnotationSpec, NativeText, OutputBasis, SourceIdentity, SourceLevel,
                                              SpanSpec, build_evidence)
from css_preparation.prepare.records import migrations

COORDINATES = 'synthetic:unicode-scalars/1'
# Decomposed (NFD) wording must survive exactly; preparation never normalises stored text.
DECOMPOSED = unicodedata.normalize('NFD', 'é')


def database():
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    for path in migrations():
        db.executescript(path.read_text(encoding='utf-8'))
    return db


def save(records, db):
    """Local SQLite stand-in for the executor's D1 write: one transaction, same statements."""
    with db:
        for sql, params in records.statements():
            db.execute(sql, params)


def identity(name, scheme='synthetic:scheme-a/1', revision='1'):
    def level(kind):
        return SourceLevel(f'synthetic:{name}:{kind}', f'Synthetic {name} {kind}')
    return SourceIdentity(level('work'), level('edition'), level('representation'),
                          SourceLevel(f'synthetic:{name}:revision-{revision}', f'Synthetic {name} revision {revision}',
                                      {'synthetic': True}),
                          f'Synthetic Provider {name}', f'https://example.invalid/{name}', scheme)


def text_a():
    return NativeText(COORDINATES, (
        ('1.1', 'אב 😀 one'),
        ('1.2', f'two {DECOMPOSED} three'),
        ('1.3', 'four five six seven eight nine ten'),
        ('2.1', 'eleven'),
    ))


def spans_a():
    return [
        SpanSpec('chapter-1', 'chapter', 'Chapter 1', (('1.1', 0, 8), ('1.2', 0, 12), ('1.3', 0, 34)), 'transcribed',
                 {'method': 'synthetic structure'}),
        SpanSpec('v1.1', 'verse', '1:1', (('1.1', 0, 8),), 'transcribed', {'method': 'synthetic structure'},
                 parent_key='chapter-1'),
        SpanSpec('v1.2', 'verse', '1:2', (('1.2', 0, 12),), 'transcribed', {'method': 'synthetic structure'},
                 parent_key='chapter-1'),
        SpanSpec('v1.3', 'verse', '1:3', (('1.3', 0, 34),), 'transcribed', {'method': 'synthetic structure'},
                 parent_key='chapter-1'),
        SpanSpec('v2.1', 'verse', '2:1', (('2.1', 0, 6),), 'transcribed', {'method': 'synthetic structure'}),
        SpanSpec('gap-2.2', 'witness_gap', '2:2', (('2.1', 6, 6),), 'gap', {'gap': 'not preserved in this witness'}),
    ]


def basis(source, *, kind='evidence', parameters=None, dependencies=()):
    return OutputBasis(kind, (source.revision.id,), 'synthetic:native-text/1', parameters or {'d1_body_max_bytes': 24},
                       {'unit_ids': ['1.1', '1.2', '1.3', '2.1']}, tuple(dependencies))


def evidence_a(**changes):
    source = identity('a')
    return build_evidence(source, changes.get('text', text_a()), changes.get('spans', spans_a()), basis(source),
                          d1_body_max_bytes=24, annotations=changes.get('annotations', (
                              AnnotationSpec('note-1', 'v1.2', 'textual_note', 'Synthetic annotator',
                                             {'receipt': 'synthetic'}, {'note': 'decomposed accent kept'}),)))

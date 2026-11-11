"""Synthetic files in STEPBible's tagged word-per-line layout. Not real source material:
the words are invented letter strings, the tags are made up."""
import hashlib

from css_preparation.adapters.stepbible.source import Component

COMMIT = 'a' * 40
HEADER = [
    'Synthetic tagged text - not source material',
    '\tThis synthetic header stands in for the licence notice.',
    'Eng (Heb) Ref & Type\tWord\tTransliteration\tTranslation\tTags\tGrammar',
    '# Exo.1.1\tsummary line that is not a word row',
    '#_Translation\tnot a word row either',
]


def row(reference, *cells):
    cells = list(cells) + [''] * (16 - len(cells))
    return '\t'.join([reference, *cells])


def tahot_lines():
    return HEADER + [
        row('Exo.1.1#01=L', 'אָ/בֹג', 'a.bog', 'and/ synthetic', 'H9002/{H1234}', 'HC/Ncmsa'),
        row('Exo.1.1#02=L', 'דֶה\\־', 'deh', 'over', '{H2222}\\H9014', 'HR'),
        row('Exo.1.1#03=Q(K)', 'וָז', 'vaz', 'he made', '{H3333}', 'HVqp3ms', '', 'K= וָזז (synthetic)'),
        row('Exo.1.1#04=L', 'חַט\\׃\\ \\פ', 'chat', 'thing', '{H4444}\\H9016\\ \\H9017', 'HNcfsa'),
        '',
        row('Exo.1.2(1.3)#01=X', 'יָכ', 'yak', 'name', '{H5555}', 'HNpm'),
        row('Exo.1.2(1.3)#02=Q(K)', '', '', '', '', '', 'K= לְמ (synthetic)'),
        row('Exo.1.2(1.3)#03=L', 'נֶס\\׃', 'nes', 'end', '{H66667}\\H9016', 'ANcmsa'),
    ]


def tagnt_lines():
    return HEADER + [
        row('Mat.1.1#01=NKO', 'Αβγ (Abg)', 'first', 'G1111=N-NSF', 'αβγ=first', 'NA28+NA27+TR+Byz'),
        row('Mat.1.1#02=K', 'δεζ (dez)', 'second', 'G2222=V-PAI-3S', 'δεζ=second', 'TR+Byz'),
        row('Mat.1.1#03=NKO', 'κἀγώ, (kagō)', 'and I', 'G2532=CONJ + G1473=P-1NS', 'κἀγώ=and I',
            'NA28+NA27+TR«4+Byz', 'synthetic meaning variant'),
        row('Mat.1.1#04=NKO', 'δι᾽ (di)', 'through', 'G1223=PREP', 'διά=through', 'NA28+TR'),
        row('Mat.1.2(1.3)#01=NKO', 'ηθι. (ēthi)', 'there', 'G20447=ADV', 'ηθι=there', 'NA28+TR'),
        row('Mat.1.4#01=K', 'λμν (lmn)', 'extra', 'G4444=N-NSM', 'λμν=extra', 'TR+Byz'),
    ]


def data(lines):
    return ('\n'.join(lines) + '\n').encode('utf-8')


def component(source='tahot', lines=None):
    lines = lines if lines is not None else (tahot_lines() if source == 'tahot' else tagnt_lines())
    raw = data(lines)
    name = 'tahot-gen-deu' if source == 'tahot' else 'tagnt-mat-jhn'
    return Component.from_parameters({'source': source, 'commit': COMMIT, 'component': name,
                                      'path': f'Synthetic/{name}.txt', 'sha256': hashlib.sha256(raw).hexdigest(),
                                      'byte_count': len(raw)}), raw


def recipe(source='tahot', groups=None):
    from css_preparation.adapters.stepbible.recipes import book_recipe
    built, raw = component(source)
    book = 'Exo' if source == 'tahot' else 'Mat'
    units = ['Exo.1.1', 'Exo.1.3'] if source == 'tahot' else ['Mat.1.1', 'Mat.1.3', 'Mat.1.4']
    value = book_recipe(built, book, units)
    if groups is not None:
        prepare = [unit for unit in value['units'] if unit['kind'] == 'prepare'][0]
        value['units'] = [value['units'][0]] + [
            {**prepare, 'unit_id': f'prepare-{index:02d}', 'native_extent': {**prepare['native_extent'],
                                                                           'unit_ids': group}}
            for index, group in enumerate(groups, start=1)] + [
            {**value['units'][-1], 'depends_on': [f'prepare-{index:02d}' for index in range(1, len(groups) + 1)]}]
    return value, built, raw

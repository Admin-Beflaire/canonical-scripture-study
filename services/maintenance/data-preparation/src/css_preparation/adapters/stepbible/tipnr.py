"""Read TIPNR's individual name forms without inventing word positions."""
from __future__ import annotations

import re
from ..language_aid_entries import AidEntry


def read_tipnr(original: bytes, *, commit: str) -> list[AidEntry]:
    entries: list[AidEntry] = []
    category: str | None = None
    record: list[list[str]] = []

    def add_record() -> None:
        if not category or not record:
            return
        header = record[0]
        identity = header[0].strip()
        ambiguity = next((row[0].partition('=')[2].strip() for row in record
                          if row[0].startswith('@Ambiguity=')), '')
        for fields in record[1:]:
            first = fields[0].strip()
            if not first.startswith('– ') or first in ('– Total', '– Mentioned') or len(fields) < 5:
                continue
            tag = fields[2].strip()
            tags = re.findall(r'(?:^|\+)([HG]\d{4,5}[A-Za-z]?)(?=«|=)', tag)
            body = '\n'.join(('Identity: ' + identity, 'Description: ' + header[1].strip(),
                              'Form: ' + first, 'Tag: ' + tag, 'Name: ' + fields[3].strip(),
                              'References: ' + fields[4].strip(), 'Ambiguity: ' + ambiguity))
            for code in tags:
                entries.append(AidEntry(f'tipnr:{commit}:{len(entries)}', 'TIPNR',
                                        f'STEPBible-Data:{commit}', body,
                                        {'disambiguated_strong': code, 'identity': identity,
                                         'category': category, 'body_field': 'name_form',
                                         'source_limitation': 'Candidate by source tag; check references and any ambiguity link before assigning an occurrence. Relationship fields are not included.'}))

    for line in original.decode('utf-8-sig').splitlines():
        fields = line.rstrip().split('\t')
        first = fields[0].strip()
        if first.startswith('$========== '):
            add_record()
            label = first[len('$========== '):].strip()
            category = label if label in ('PERSON(s)', 'PLACE', 'PLACE+PERSON') else None
            record = []
        elif category and not record and not first.startswith(('–', '@', '$', '‖')) and '@' in first and '=' in first and len(fields) > 1:
            record = [fields]
        elif record:
            record.append(fields)
    add_record()
    if not entries:
        raise ValueError('TIPNR contains no name forms')
    return entries

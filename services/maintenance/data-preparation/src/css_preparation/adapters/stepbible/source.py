"""STEPBible TAHOT and TAGNT: source identities, coordinates, acquisition and admission records.

The reviewed recipe pins the exact STEPBible-Data commit, file path, SHA-256 and size of one
component file. Nothing here chooses a source or decides admission: the owner's admission
decision is given to Maintenance Control, and this module records the licence basis the
reviewed recipe states. The licence (CC BY 4.0) permits keeping, redistributing and sending the
data to AI hosts with attribution. STEPBible asks (a request, not a licence condition) that copies
of the data files are not posted elsewhere; that request is kept as a notice. By the owner's
decision the originals are kept only in protected private storage (R2), not in Git.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Any, Mapping
import urllib.parse

from ...acquire.retention import AdmissionBasis, InputRecord, assert_usable
from ...prepare.evidence import SourceIdentity, SourceLevel
from ...prepare.records import RecordError
from .format import Language

ORIGIN = 'https://github.com/STEPBible/STEPBible-Data'
RAW_HOST = 'raw.githubusercontent.com'
PROVIDER = 'STEPBible.org/Tyndale House'
LICENCE = 'CC BY 4.0'
_COMMIT = re.compile(r'[0-9a-f]{40}')
_COMPONENT = re.compile(r'(tahot|tagnt)-[a-z0-9]+-[a-z0-9]+')
_HEX = re.compile(r'[0-9a-f]{64}')
# Book order of each source's files; the ordinal fixes the book's place in the linear order.
BOOKS = {
    'tahot': ('Gen', 'Exo', 'Lev', 'Num', 'Deu', 'Jos', 'Jdg', 'Rut', '1Sa', '2Sa', '1Ki', '2Ki', '1Ch', '2Ch',
              'Ezr', 'Neh', 'Est', 'Job', 'Psa', 'Pro', 'Ecc', 'Sng', 'Isa', 'Jer', 'Lam', 'Ezk', 'Dan', 'Hos',
              'Jol', 'Amo', 'Oba', 'Jon', 'Mic', 'Nam', 'Hab', 'Zep', 'Hag', 'Zec', 'Mal'),
    'tagnt': ('Mat', 'Mrk', 'Luk', 'Jhn', 'Act', 'Rom', '1Co', '2Co', 'Gal', 'Eph', 'Php', 'Col', '1Th', '2Th',
              '1Ti', '2Ti', 'Tit', 'Phm', 'Heb', 'Jas', '1Pe', '2Pe', '1Jn', '2Jn', '3Jn', 'Jud', 'Rev'),
}
BOOK_STRIDE = 2**32  # Linear order: book ordinal × 2^32 + Unicode scalars within the book.


@dataclass(frozen=True)
class Declaration:
    key: str
    language: Language
    title: str
    edition: str
    edition_name: str
    versification: str
    base_text: str
    analysis_basis: str


SOURCES = {
    'tahot': Declaration(
        'tahot', 'hebrew', 'Translators Amalgamated Hebrew OT (TAHOT)', 'translators-text',
        "TAHOT translators' text: Leningrad codex following the Qere, with restored and LXX-based words marked",
        'hebrew', 'Every TAHOT word row (L, Q, R and X text types); Ketiv and other variants are annotations',
        'TAHOT dStrongs+Grammar'),
    'tagnt': Declaration(
        'tagnt', 'greek', 'Translators Amalgamated Greek NT (TAGNT)', 'na28-words',
        'TAGNT words found in NA28, in TAGNT spelling (NA28 where available)',
        'nestle-aland', 'TAGNT word rows whose editions include NA28; other editions\' words are annotations',
        'TAGNT dStrong=Grammar'),
}


@dataclass(frozen=True)
class Component:
    """One pinned STEPBible-Data file, as the reviewed recipe declares it."""
    source: Declaration
    commit: str
    component: str
    path: str
    sha256: str
    byte_count: int

    @classmethod
    def from_parameters(cls, parameters: Mapping[str, Any]) -> 'Component':
        source = SOURCES.get(parameters.get('source'))
        commit, component = parameters.get('commit'), parameters.get('component')
        path, sha256, size = parameters.get('path'), parameters.get('sha256'), parameters.get('byte_count')
        if (source is None or not isinstance(commit, str) or not _COMMIT.fullmatch(commit)
                or not isinstance(component, str) or not _COMPONENT.fullmatch(component)
                or not component.startswith(source.key + '-')
                or not isinstance(path, str) or not path.endswith('.txt') or '..' in path.split('/')
                or path.startswith('/') or not isinstance(sha256, str) or not _HEX.fullmatch(sha256)
                or type(size) is not int or not 0 < size <= 64_000_000):
            raise RecordError('Recipe does not declare a pinned STEPBible component')
        return cls(source, commit, component, path, sha256, size)

    @property
    def revision_id(self) -> str:
        return f'stepbible-{self.source.key}:{self.commit[:12]}'

    @property
    def analysis_revision_id(self) -> str:
        return f'{self.revision_id}:tags'

    @property
    def acquisition_id(self) -> str:
        return f'stepbible-data:{self.commit[:12]}:{self.component}'

    @property
    def coordinate_version(self) -> str:
        return f'stepbible-{self.source.key}:{self.source.versification}-verses/1'

    @property
    def url(self) -> str:
        return (f'https://{RAW_HOST}/STEPBible/STEPBible-Data/{self.commit}/'
                + urllib.parse.quote(self.path, safe='/'))

    def identity(self) -> SourceIdentity:
        """Identical for every component of the revision, so shared rows never conflict."""
        source = self.source
        work = f'stepbible-{source.key}'
        return SourceIdentity(
            SourceLevel(work, source.title),
            SourceLevel(f'{work}:{source.edition}', source.edition_name),
            SourceLevel(f'{work}:{source.edition}:tagged-text', 'STEPBible tagged word-per-line text'),
            SourceLevel(self.revision_id, f'STEPBible-Data commit {self.commit[:12]}',
                        {'commit': self.commit, 'licence': LICENCE, 'base_text': source.base_text}),
            f'{source.title} by STEPBible.org, based on work at Tyndale House Cambridge; {LICENCE}; '
            'https://STEPBible.github.io/STEPBible-Data',
            ORIGIN, f'stepbible-{source.key}:{source.versification}')

    def admission(self) -> AdmissionBasis:
        return AdmissionBasis(
            decision_refs=('Maintenance Control task admission decision',),
            terms_basis=f'{LICENCE} licence notice in {self.path} at STEPBible-Data commit {self.commit}',
            both_hosts_eligible=True, public_redistribution='allowed')

    def input_record(self, upstream_basis: str = 'git-commit') -> InputRecord:
        return InputRecord(self.revision_id, self.component, self.acquisition_id, f'{upstream_basis}:{self.commit}',
                           self.byte_count, self.sha256, True, self.admission(),
                           (self.identity().attribution,))

    @property
    def original_key(self) -> str:
        """Protected private key. Public redistribution is allowed, but the owner keeps these
        originals in R2 only, so the public-Git route is never used for them."""
        assert_usable(self.input_record())
        return f'originals/{self.revision_id}/{self.sha256}/{self.component}.txt'

    def admission_row(self) -> dict[str, Any]:
        basis = self.admission()
        return {'id': f'{self.revision_id}:{self.component}', 'source_revision_id': self.revision_id,
                'component': self.component, 'terms_basis': basis.terms_basis,
                'permitted_uses_json': ['acquire', 'retain', 'backup', 'prepare', 'chatgpt', 'claude'],
                'restrictions_json': ['Attribute Tyndale House and STEPBible.org with a link to '
                                      'STEPBible.github.io/STEPBible-Data',
                                      'Make changes to the data visible to its users'],
                'notices_json': [self.identity().attribution,
                                 'STEPBible asks: please do not post copies of this data file elsewhere, '
                                 'so that it remains the single up-to-date source'],
                'both_hosts_eligible': basis.both_hosts_eligible,
                'public_redistribution': basis.public_redistribution}

    def check_original(self, data: bytes) -> bytes:
        if len(data) != self.byte_count or hashlib.sha256(data).hexdigest() != self.sha256:
            raise RecordError('Retained original differs from the pinned component')
        return data

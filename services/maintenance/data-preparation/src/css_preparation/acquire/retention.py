"""Exact-original input records, admission basis and storage routing.

Preparation records the owner's decision references; it never makes an admission decision
or reassesses unchanged permissions. Unresolved eligibility blocks the affected input.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from pathlib import Path, PurePosixPath
import re
from typing import Iterable, Literal

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}')
NOTICE_NAMES = ('license', 'licence', 'readme', 'notice', 'copying', 'copyright')


class BlockedInput(ValueError):
    """The input cannot be used: eligibility is unresolved or the record is inconsistent."""


@dataclass(frozen=True)
class AdmissionBasis:
    decision_refs: tuple[str, ...]
    terms_basis: str
    both_hosts_eligible: bool | None
    public_redistribution: Literal['allowed', 'not_allowed', 'unresolved']


@dataclass(frozen=True)
class InputRecord:
    source_revision_id: str
    component: str
    origin: str
    upstream_basis: str
    byte_count: int
    sha256: str
    complete: bool
    admission: AdmissionBasis
    notices: tuple[str, ...] = ()
    coverage: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self):
        for value in (self.source_revision_id, self.component, self.origin):
            if not ID.fullmatch(value):
                raise BlockedInput(f'Unsafe identifier {value[:40]!r}')
        if not re.fullmatch(r'[0-9a-f]{64}', self.sha256) or self.byte_count < 0 or not self.upstream_basis:
            raise BlockedInput('Input needs exact bytes, digest and upstream basis')


def assert_usable(record: InputRecord) -> None:
    """Block anything not admitted for both hosts on an owner decision, or not completely retained."""
    basis = record.admission
    if not basis.decision_refs or not basis.terms_basis:
        raise BlockedInput(f'{record.source_revision_id}: no owner admission decision recorded')
    if basis.both_hosts_eligible is not True:
        raise BlockedInput(f'{record.source_revision_id}: not eligible for both hosts')
    if not record.complete:
        raise BlockedInput(f'{record.source_revision_id}: original is incomplete')


def storage_route(record: InputRecord, filename: str) -> tuple[Literal['public_git', 'protected'], str]:
    """`sources/` only with recorded public redistribution; otherwise an account-independent protected key."""
    assert_usable(record)
    name = PurePosixPath(filename).name
    if not name or name != filename or name.startswith('.'):
        raise BlockedInput('Unsafe original file name')
    if record.admission.public_redistribution == 'allowed':
        return 'public_git', f'sources/{record.source_revision_id}/{name}'
    return 'protected', f'originals/{record.source_revision_id}/{record.sha256}/{name}'


def record_supplied(path: Path, *, source_revision_id: str, component: str, admission: AdmissionBasis,
                    coverage: Iterable[str] = (), notices: Iterable[str] = ()) -> InputRecord:
    """Record an owner-supplied original exactly as received."""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return InputRecord(source_revision_id, component, 'supplied', f'sha256:{digest.hexdigest()}', size,
                       digest.hexdigest(), True, admission, tuple(notices), frozenset(coverage))


def reusable(records: Iterable[InputRecord], source_revision_id: str, coverage: Iterable[str]) -> InputRecord | None:
    """Reuse a retained input only for the same revision, complete, covering the requested extent."""
    wanted = frozenset(coverage)
    for record in records:
        if record.source_revision_id == source_revision_id and record.complete and wanted <= record.coverage:
            return record
    return None


def notice_members(names: Iterable[str]) -> tuple[str, ...]:
    """Licence/readme/notice files that must travel with the original."""
    return tuple(sorted(name for name in names if PurePosixPath(name).name.lower().startswith(NOTICE_NAMES)))

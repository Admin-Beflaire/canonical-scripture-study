"""Exact-original input records and their admission basis.

Preparation records the owner's decision references; it never makes an admission decision
or reassesses unchanged permissions. Unresolved eligibility blocks the affected input.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Literal

from css_shared.error_record import OwnMessage

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")


class BlockedInputError(OwnMessage, ValueError):
    """The input cannot be used: eligibility is unresolved or the record is inconsistent."""


@dataclass(frozen=True)
class AdmissionBasis:
    decision_refs: tuple[str, ...]
    terms_basis: str
    both_hosts_eligible: bool | None
    public_redistribution: Literal["allowed", "not_allowed", "unresolved"]


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
            # IDs become storage path segments: no empty, `.` or `..` parts.
            if not ID.fullmatch(value) or any(
                part in ("", ".", "..") for part in value.split("/")
            ):
                raise BlockedInputError("Unsafe identifier")
        if (
            not re.fullmatch(r"[0-9a-f]{64}", self.sha256)
            or self.byte_count < 0
            or not self.upstream_basis
        ):
            raise BlockedInputError(
                "Input needs exact bytes, digest and upstream basis"
            )


def assert_usable(record: InputRecord) -> None:
    """Block anything not admitted for both hosts on an owner decision, or not completely retained."""
    basis = record.admission
    if not basis.decision_refs or not basis.terms_basis:
        raise BlockedInputError(
            f"{record.source_revision_id}: no owner admission decision recorded"
        )
    if basis.both_hosts_eligible is not True:
        raise BlockedInputError(
            f"{record.source_revision_id}: not eligible for both hosts"
        )
    if not record.complete:
        raise BlockedInputError(f"{record.source_revision_id}: original is incomplete")

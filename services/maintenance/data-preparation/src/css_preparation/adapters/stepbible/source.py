"""STEPBible TAHOT and TAGNT: source identities, coordinates and pinned component files.

The reviewed recipe pins the exact STEPBible-Data commit, file path, SHA-256 and size of one
component file. Nothing here chooses a source or decides admission: the owner's admission
decision is given to Maintenance Control, and the fetch recipe states the admission record
that Preparation saves and Control compares. The licence (CC BY 4.0) permits keeping, redistributing and sending the
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

from ...prepare.evidence import SourceIdentity, SourceLevel, canonical_digest
from ...prepare.records import RecordError
from ...recipe_source import source_variables
from .format import Language

ORIGIN = "https://github.com/STEPBible/STEPBible-Data"
RAW_HOST = "raw.githubusercontent.com"
LICENCE = "CC BY 4.0"
_COMMIT = re.compile(r"[0-9a-f]{40}")
_COMPONENT = re.compile(r"(tahot|tagnt)-[a-z0-9]+-[a-z0-9]+")
_HEX = re.compile(r"[0-9a-f]{64}")
BOOK_STRIDE = (
    2**32
)  # Linear order: book ordinal × 2^32 + Unicode scalars within the book.


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
    provider: str
    base_edition: str | None
    books: list[str]


def source_profile(source: str, key: str) -> Declaration:
    return Declaration(**source_variables(f"stepbible-{source}")["profiles"][key])


_SOURCES = ("tahot", "tagnt")
BOOKS = {key: source_profile(key, "1").books for key in _SOURCES}
PROVIDER = source_profile("tahot", "1").provider


@dataclass(frozen=True)
class Component:
    """One pinned STEPBible-Data file, as the reviewed recipe declares it."""

    source: Declaration
    commit: str
    component: str
    path: str
    sha256: str
    byte_count: int
    profile: str = "1"

    @classmethod
    def from_parameters(cls, parameters: Mapping[str, Any]) -> "Component":
        source, profile = (
            parameters.get("source"),
            parameters.get("source_profile", "1"),
        )
        commit, component = parameters.get("commit"), parameters.get("component")
        path, sha256, size = (
            parameters.get("path"),
            parameters.get("sha256"),
            parameters.get("byte_count"),
        )
        if (
            source not in _SOURCES
            or not isinstance(profile, str)
            or not isinstance(commit, str)
            or not _COMMIT.fullmatch(commit)
            or not isinstance(component, str)
            or not _COMPONENT.fullmatch(component)
            or not component.startswith(source + "-")
            or not isinstance(path, str)
            or not path.endswith(".txt")
            or ".." in path.split("/")
            or path.startswith("/")
            or not isinstance(sha256, str)
            or not _HEX.fullmatch(sha256)
            or type(size) is not int
            or not 0 < size <= 64_000_000
        ):
            raise RecordError("Recipe does not declare a pinned STEPBible component")
        try:
            selected = source_profile(source, profile)
        except KeyError:
            raise RecordError("Unknown STEPBible source profile") from None
        return cls(selected, commit, component, path, sha256, size, profile)

    def reuse_parameters(self) -> dict[str, str]:
        if self.profile == "1":
            return {}  # Migration preserves existing prepared-output identities.
        return {"source_profile": canonical_digest(vars(self.source))}

    @property
    def revision_id(self) -> str:
        return f"stepbible-{self.source.key}:{self.commit[:12]}"

    @property
    def analysis_revision_id(self) -> str:
        return f"{self.revision_id}:tags"

    @property
    def acquisition_id(self) -> str:
        return f"stepbible-data:{self.commit[:12]}:{self.component}"

    @property
    def coordinate_version(self) -> str:
        return f"stepbible-{self.source.key}:{self.source.versification}-verses/1"

    @property
    def url(self) -> str:
        return (
            f"https://{RAW_HOST}/STEPBible/STEPBible-Data/{self.commit}/"
            + urllib.parse.quote(self.path, safe="/")
        )

    def identity(self) -> SourceIdentity:
        """Identical for every component of the revision, so shared rows never conflict."""
        source = self.source
        work = f"stepbible-{source.key}"
        return SourceIdentity(
            SourceLevel(work, source.title),
            SourceLevel(f"{work}:{source.edition}", source.edition_name),
            SourceLevel(
                f"{work}:{source.edition}:tagged-text",
                "STEPBible tagged word-per-line text",
            ),
            SourceLevel(
                self.revision_id,
                f"STEPBible-Data commit {self.commit[:12]}",
                {
                    "commit": self.commit,
                    "licence": LICENCE,
                    "base_text": source.base_text,
                },
            ),
            f"{source.title} by STEPBible.org, based on work at Tyndale House Cambridge; {LICENCE}; "
            "https://STEPBible.github.io/STEPBible-Data",
            ORIGIN,
            f"stepbible-{source.key}:{source.versification}",
        )

    @property
    def original_key(self) -> str:
        """Protected private key. Public redistribution is allowed, but the owner keeps these
        originals in R2 only, so the public-Git route is never used for them."""
        return f"originals/{self.revision_id}/{self.sha256}/{self.component}.txt"

    def task_inputs(self) -> list[dict[str, str]]:
        """The two inputs a task for this file names: its acquisition route and its source revision."""
        return [
            {"kind": "acquisition", "id": self.acquisition_id},
            {"kind": "source_revision", "id": self.revision_id},
        ]

    def declares_acquisition(self, reference: Mapping[str, Any]) -> bool:
        """The reviewed recipe vouches for this file's acquisition route before it is saved."""
        return (
            reference.get("kind") == "acquisition"
            and reference.get("id") == self.acquisition_id
            and reference.get("sha256", self.sha256) == self.sha256
            and reference.get("byte_count", self.byte_count) == self.byte_count
        )

    def check_inputs(self, job: Mapping[str, Any]) -> None:
        """A job names this file's acquisition route and its source revision."""
        refs = {(ref["kind"], ref["id"]) for ref in job["input_refs"]}
        if (
            not {
                ("acquisition", self.acquisition_id),
                ("source_revision", self.revision_id),
            }
            <= refs
        ):
            raise RecordError(
                "The task does not name this recipe's acquisition and source revision"
            )

    def check_original(self, data: bytes) -> bytes:
        if (
            len(data) != self.byte_count
            or hashlib.sha256(data).hexdigest() != self.sha256
        ):
            raise RecordError("Retained original differs from the pinned component")
        return data

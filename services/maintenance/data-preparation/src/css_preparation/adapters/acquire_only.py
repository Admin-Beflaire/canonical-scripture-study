"""Retain a reviewed archive without extracting or parsing it."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any, Mapping
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from ..acquire.fetch import fetch_original
from ..acquire.retention import declared_admission
from ..acquire.transfer import Route
from ..prepare.evidence import SourceIdentity, SourceLevel
from ..prepare.records import RecordError, RecordSet, comparable
from ..validation import SCHEMAS
from . import AdapterDeclaration, AdapterRegistry
from .retained import retained_identity

DECLARATION = AdapterDeclaration(
    "acquire-only",
    "acquire-only/1",
    frozenset({"archive/opaque"}),
    frozenset(),
    frozenset({"manifest"}),
)
MANIFESTS = SCHEMAS.parent / "collection" / "manifests"
# Where a source's bytes may be, stated as a restriction of its admission record. A
# third-party original stays private. The second value is only for the owner's own file that
# the public repository holds; the record's terms basis states the owner's permission for
# that public placement.
PRIVATE_STORAGE = "Protected private storage only; never public Git"
OWNER_PUBLIC_STORAGE = "Owner file in the public repository; the acquired copy in protected private storage"


def _placement_matches(row: Mapping[str, Any]) -> bool:
    """Exactly one storage rule, and public placement is permitted only for the owner's file."""
    rules = [
        rule
        for rule in row["restrictions_json"]
        if rule in (PRIVATE_STORAGE, OWNER_PUBLIC_STORAGE)
    ]
    public = rules == [OWNER_PUBLIC_STORAGE]
    return (
        len(rules) == 1
        and ("git_history" in row["permitted_uses_json"]) == public
        and (row["public_redistribution"] == "allowed") == public
    )


def _manifest(name: str) -> Mapping[str, Any]:
    manifest = json.loads((MANIFESTS / name).read_text(encoding="utf-8"))
    required = (
        "manifest_revision",
        "source_revision",
        "provider",
        "origin",
        "version",
        "admission",
        "url",
    )
    if any(not isinstance(manifest.get(k), str) or not manifest[k] for k in required):
        raise RecordError("Incomplete acquisition manifest")
    return manifest


def _route_valid(manifest: Mapping[str, Any]) -> bool:
    hosts, limit = manifest.get("allowed_hosts"), manifest.get("max_bytes")
    expected, size = manifest.get("expected_sha256"), manifest.get("byte_count")
    parts = urlsplit(manifest["url"])
    return bool(
        re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9][A-Za-z0-9._:-]*)*",
            manifest["source_revision"],
        )
        and isinstance(hosts, list)
        and hosts
        and all(isinstance(h, str) and re.fullmatch(r"[a-z0-9.-]+", h) for h in hosts)
        and parts.scheme == "https"
        and parts.hostname in hosts
        and not parts.username
        and not parts.password
        and type(limit) is int
        and 0 < limit <= 64_000_000
        and (size is None or (type(size) is int and 0 < size <= limit))
        and (
            expected is None
            or (isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected))
        )
    )


def _recipe_matches(recipe: Mapping[str, Any], manifest: Mapping[str, Any]) -> bool:
    extent = {"component": manifest["source_revision"]}
    return (
        recipe.get("manifest_revision") == manifest["manifest_revision"]
        and recipe["dependencies"] == [manifest["manifest_revision"]]
        and not recipe["capabilities"]
        and recipe["native_extent"] == extent
        and recipe.get("units")
        == [
            {
                "unit_id": "acquire",
                "kind": "acquire",
                "native_extent": extent,
                "depends_on": [],
            }
        ]
    )


@dataclass(frozen=True)
class AcquireRecipe:
    recipe: Mapping[str, Any]
    manifest: Mapping[str, Any]
    admission: Mapping[str, Any]

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> "AcquireRecipe":
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        params = recipe["parameters"]
        name = params.get("manifest")
        if (
            set(params) != {"manifest"}
            or not isinstance(name, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.json", name)
        ):
            raise RecordError("Acquire-only recipe needs a manifest filename")
        manifest = _manifest(name)
        admission = declared_admission(
            manifest.get("admission_record"), manifest["source_revision"], "archive"
        )
        if not (
            _route_valid(manifest)
            and _recipe_matches(recipe, manifest)
            and _placement_matches(admission)
            and manifest["admission"]
            == "Owner decision in the Maintenance Control task"
        ):
            raise RecordError("Invalid acquire-only route or recipe")
        return cls(recipe, manifest, admission)

    def declares(self, ref: Mapping[str, Any], kind: str) -> bool:
        if kind != "acquire":
            return False
        if ref.get("kind") == "acquisition":
            return ref == {
                "kind": "acquisition",
                "id": self.manifest["manifest_revision"],
            }
        return ref == {
            "kind": "source_revision",
            "id": self.manifest["source_revision"],
        }

    def _check_job(self, job: Mapping[str, Any], unit: str = "acquire") -> None:
        refs = job["input_refs"]
        if (
            job["unit_id"] != unit
            or job["native_extent"] != self.recipe["native_extent"]
            or not all(
                any(
                    self.declares(ref, "acquire") and ref["kind"] == kind
                    for ref in refs
                )
                for kind in ("acquisition", "source_revision")
            )
        ):
            raise RecordError("Acquisition job does not match the reviewed recipe")

    def _key(self, digest: str) -> str:
        return f"originals/{self.manifest['source_revision']}/{digest}/original"

    def _recorded(self, storage: Any) -> Mapping[str, Any] | None:
        """The digest and size the saved source revision records, if it records an original."""
        node = storage.read_row("source_node", self.manifest["source_revision"])
        details = node.get("details_json") if node else None
        if not isinstance(details, Mapping):
            return None
        return details if {"sha256", "byte_count"} <= set(details) else None

    def _kept(self, storage: Any, recorded: Mapping[str, Any] | None) -> bytes | None:
        """The stored original under the pinned digest, else the recorded one, verified."""
        pinned = self.manifest.get("expected_sha256")
        digest = pinned or (recorded or {}).get("sha256")
        if not digest:
            return None
        try:
            data = storage.read_blob(self._key(digest))
        except KeyError:
            return None
        size = self.manifest.get("byte_count") if pinned else recorded["byte_count"]
        if hashlib.sha256(data).hexdigest() != digest or size not in (None, len(data)):
            raise RecordError("The stored original does not match its digest and size")
        return data

    def read_original(self, job: Mapping[str, Any], storage: Any) -> tuple[bytes, str]:
        """Read a kept, admitted original through this fetch recipe, without fetching."""
        self._check_job(job, "analyse")
        recorded = self._recorded(storage)
        saved = storage.read_row("admission", self.admission["id"])
        if (
            not recorded
            or recorded.get("url") != self.manifest["url"]
            or saved is None
            or dict(saved) != comparable("admission", self.admission)
        ):
            raise RecordError("No matching retained original and admission")
        pinned = self.manifest.get("expected_sha256")
        kept = self._kept(storage, recorded)
        if (
            kept is None
            or pinned not in (None, recorded["sha256"])
            or len(kept) != recorded["byte_count"]
        ):
            raise RecordError(
                "The retained original does not match its recorded digest and size"
            )
        path = PurePosixPath(urlsplit(self.manifest["url"]).path)
        return kept, path.name or "original"

    def _download(self) -> tuple[bytes, str]:
        m = self.manifest
        route = Route(
            m["manifest_revision"],
            m["url"],
            frozenset(m["allowed_hosts"]),
            m["max_bytes"],
            m.get("expected_sha256"),
        )
        data, result = fetch_original(route)
        if (
            len(data) != result.byte_count
            or hashlib.sha256(data).hexdigest() != result.sha256
        ):
            raise RecordError("Acquired bytes differ from the transfer receipt")
        return data, result.upstream_basis

    def _identity(self, data: bytes, upstream_basis: str) -> SourceIdentity:
        m = self.manifest
        revision = m["source_revision"]
        digest = hashlib.sha256(data).hexdigest()
        return SourceIdentity(
            SourceLevel(revision + ":work", m["provider"]),
            SourceLevel(revision + ":edition", m["provider"]),
            SourceLevel(revision + ":archive", "Opaque source archive"),
            SourceLevel(
                revision,
                m["version"],
                {
                    "sha256": digest,
                    "byte_count": len(data),
                    "locator": self._key(digest),
                    "upstream_basis": upstream_basis,
                    "url": m["url"],
                },
            ),
            # The first notice of the admission record is the source's attribution.
            self.admission["notices_json"][0],
            m["origin"],
        )

    def acquire(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        """Keep the original and register its source and admission.

        A kept original is verified and nothing is downloaded. Once a source revision records
        an original, only those bytes are saved under it, and its identity stays as recorded.
        """
        self._check_job(job)
        revision = self.manifest["source_revision"]
        recorded = self._recorded(storage)
        kept = self._kept(storage, recorded)
        data, upstream = (
            (kept, "retained-original") if kept is not None else self._download()
        )
        digest = hashlib.sha256(data).hexdigest()
        if recorded and (digest, len(data)) != (
            recorded["sha256"],
            recorded["byte_count"],
        ):
            raise RecordError(
                f"The obtained bytes differ from those recorded for {revision}; nothing "
                "was saved under it. Using them needs a new source revision with its own "
                "admission"
            )
        if kept is None:
            storage.put_blob(self._key(digest), data)
            if storage.read_blob(self._key(digest)) != data:
                raise RecordError("Retained original failed readback")
        identity = (
            retained_identity(storage, revision)
            if recorded
            else self._identity(data, upstream)
        )
        records = RecordSet()
        for row in identity.rows():
            records.add("source_node", row)
        records.add("admission", dict(self.admission))
        return records

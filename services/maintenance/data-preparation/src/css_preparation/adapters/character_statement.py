"""Prepare the owner's character-of-God statement from its retained original.

The original is the versioned statement file. Preparation copies its name, version,
status, approval reference, scriptural basis and wording into one statement record; it
never approves, rewords or completes them. Quality rebuilds the record from the original
and compares it with what was saved.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Mapping

from ..prepare.evidence import NativeText, OutputBasis
from ..prepare.records import RecordError, RecordSet
from . import AdapterDeclaration, AdapterRegistry
from .retained import retained_identity, retained_original

NAME = "character-statement"
METHOD_VERSION = "character-statement/1"
INPUT_FORMAT = "character-statement/original"
# The statement file's format, and the single native unit that holds its wording.
FORMAT = "character-statement/1"
COORDINATES = "character-statement/1"
UNIT = "statement"
KIND = "character_statement"
DECLARATION = AdapterDeclaration(
    NAME,
    METHOD_VERSION,
    frozenset({INPUT_FORMAT}),
    frozenset({KIND}),
    frozenset({"source_revision"}),
)
_FIELDS = (
    "statement_format",
    "name",
    "version",
    "status",
    "owner_approval_ref",
    "scripture_basis",
    "wording",
)


def parse_statement(data: bytes) -> dict[str, Any]:
    """The statement file's fields, with its paragraphs joined into the wording."""
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise RecordError("The statement file is not UTF-8 JSON") from error
    if (
        not isinstance(value, dict)
        or set(value) != set(_FIELDS)
        or value["statement_format"] != FORMAT
    ):
        raise RecordError(
            f"The statement file needs exactly the {FORMAT} fields: {', '.join(_FIELDS)}"
        )
    paragraphs = value["wording"]
    if (
        not isinstance(paragraphs, list)
        or not paragraphs
        or any(not isinstance(p, str) or not p.strip() for p in paragraphs)
    ):
        raise RecordError("The statement wording is a list of non-empty paragraphs")
    if value["status"] == "approved" and not value["owner_approval_ref"]:
        raise RecordError("An approved statement needs its owner approval reference")
    return {**value, "wording": "\n\n".join(paragraphs)}


@dataclass(frozen=True)
class StatementRecipe:
    recipe: Mapping[str, Any]
    revision: str

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> "StatementRecipe":
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        revision = recipe["parameters"].get("source_revision")
        extent = {"unit_ids": [UNIT], "coordinate_version": COORDINATES}
        units = [
            {
                "unit_id": "prepare",
                "kind": "prepare",
                "native_extent": extent,
                "depends_on": [],
            },
            {
                "unit_id": "quality",
                "kind": "quality",
                "native_extent": extent,
                "depends_on": ["prepare"],
                "required_capabilities": [KIND],
            },
        ]
        if (
            not isinstance(revision, str)
            or not revision
            or recipe["native_extent"]
            != {"component": revision, "coordinate_version": COORDINATES}
            or recipe["capabilities"] != [KIND]
            or recipe.get("units") != units
            or recipe.get("dependencies") != [revision]
            or recipe.get("task_inputs")
            != [{"kind": "source_revision", "id": revision}]
        ):
            raise RecordError("Statement recipe differs from its declared units")
        return cls(recipe, revision)

    def _statement(self, storage: Any) -> dict[str, Any]:
        return parse_statement(retained_original(storage, self.revision))

    def _records(self, storage: Any) -> RecordSet:
        """The output, its stored record file, the statement row and its coverage."""
        statement = self._statement(storage)
        basis = OutputBasis(
            KIND,
            (self.revision,),
            METHOD_VERSION,
            {},
            {"coordinate_version": COORDINATES, "unit_ids": [UNIT]},
        )
        output_id = basis.output_id
        records = RecordSet()
        for row in retained_identity(storage, self.revision).rows():
            records.add("source_node", row)
        records.add("prepared_output", basis.row())
        row = {
            "id": f"{output_id}:statement",
            "output_id": output_id,
            "name": statement["name"],
            "version": statement["version"],
            "status": statement["status"],
            "scripture_basis_json": statement["scripture_basis"],
            "wording": statement["wording"],
            "owner_approval_ref": statement["owner_approval_ref"],
        }
        data = json.dumps(
            row, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        artifact = f"{output_id}:record"
        records.add(
            "artifact",
            {
                "id": artifact,
                "source_revision_id": self.revision,
                "output_id": output_id,
                "sha256": digest,
                "byte_count": len(data),
                "format": "application/json",
                "registered_locator": f"prepared/{digest}/character-statement.json",
            },
        )
        records.add_blob(artifact, data)
        records.add(KIND, row)
        records.add(
            "coverage",
            {
                "output_id": output_id,
                "source_revision_id": self.revision,
                "native_extent_json": {"unit_ids": [UNIT]},
                "capability": KIND,
                "state": "available",
                "method_version": METHOD_VERSION,
                "index_artifact_id": artifact,
                "dependencies_json": [],
                "limitation": None,
            },
        )
        return records

    def _check_revision(self, revision: str) -> None:
        if revision != self.revision:
            raise RecordError("Quality requested a different source revision")

    def read_source(self, revision: str, storage: Any) -> NativeText:
        self._check_revision(revision)
        return NativeText(COORDINATES, ((UNIT, self._statement(storage)["wording"]),))

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        planned = self.recipe["units"][0]
        if (
            job.get("kind") != "prepare"
            or job.get("unit_id") != planned["unit_id"]
            or job.get("native_extent") != planned["native_extent"]
        ):
            raise RecordError("Statement unit is outside its reviewed recipe")
        if not any(
            ref == {"kind": "source_revision", "id": self.revision}
            for ref in job.get("input_refs", [])
        ):
            raise RecordError("Task does not name the statement's source revision")
        return self._records(storage)

    def read_statements(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        """What the prepare unit should have saved, rebuilt from the retained original."""
        return self._records(storage)

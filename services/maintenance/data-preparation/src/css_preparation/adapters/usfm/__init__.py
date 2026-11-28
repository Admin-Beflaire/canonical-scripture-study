"""A reviewed book recipe for native USFM text or checked reader references."""

from dataclasses import dataclass
from typing import Any, Mapping

from ...prepare.evidence import NativeText
from ...prepare.reader_references import READER_REFERENCE
from ...prepare.records import RecordError, RecordSet
from .. import AdapterDeclaration, AdapterRegistry
from .prepare import CAPABILITIES, METHOD, prepare_text
from .reader import prepare_reader
from .source import UsfmSource, book_units, preparation_basis

INPUT_FORMAT = "archive/usfm"
DECLARATION = AdapterDeclaration(
    "usfm-text",
    METHOD,
    frozenset({INPUT_FORMAT}),
    frozenset((*CAPABILITIES, READER_REFERENCE)),
    frozenset({"variables", "archive_sha256", "member_sha256", "basis_sha256"}),
)


@dataclass(frozen=True)
class UsfmRecipe:
    recipe: Mapping[str, Any]
    source: UsfmSource

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> "UsfmRecipe":
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        extent = recipe["native_extent"]
        source = UsfmSource.from_parameters(recipe["parameters"], extent["book"])
        bound = cls(recipe, source)
        bound._check_recipe()
        return bound

    @property
    def reader(self) -> bool:
        return self.recipe["capabilities"] == [READER_REFERENCE]

    @property
    def source_basis(self) -> str:
        return self.recipe["parameters"]["basis_sha256"]

    def _check_recipe(self) -> None:
        recipe, source = self.recipe, self.source
        manifest = source.acquisition.manifest
        input_ids = [
            {"kind": "acquisition", "id": manifest["manifest_revision"]},
            {"kind": "source_revision", "id": manifest["source_revision"]},
        ]
        units = book_units(source.book, source.config)
        if (
            (not self.reader and recipe["capabilities"] != list(CAPABILITIES))
            or (self.reader and "reader_mapping" not in source.config)
            or recipe["manifest_revision"] != manifest["manifest_revision"]
            or recipe["dependencies"] != [manifest["manifest_revision"]]
            or recipe["task_inputs"] != input_ids
            or recipe["native_extent"]
            != {"book": source.book, "coordinate_version": source.coordinate}
            or self.source_basis
            != preparation_basis(source.variables, manifest, source.book, self.reader)
            or recipe["units"][-1]["native_extent"]["unit_ids"] != units
        ):
            raise RecordError(
                "USFM recipe differs from its reviewed source or capabilities"
            )

    def _checked_job(self, job: Mapping[str, Any]) -> list[str]:
        declared = {(r["kind"], r["id"]) for r in self.recipe["task_inputs"]}
        actual = {(r["kind"], r["id"]) for r in job["input_refs"]}
        if not declared.issubset(actual):
            raise RecordError(
                "USFM task lacks its retained source and acquisition route"
            )
        for unit in self.recipe["units"]:
            if all(
                unit[key] == job[key] for key in ("unit_id", "kind", "native_extent")
            ):
                return unit["native_extent"]["unit_ids"]
        raise RecordError("USFM job does not match a reviewed recipe unit")

    def _reader_unit(
        self, storage: Any, text: NativeText, units: list[str]
    ) -> RecordSet:
        source = self.source
        return prepare_reader(
            source.identity(storage),
            source.book,
            text,
            source.select(text, units),
            source.config["reader_mapping"],
            source.variables["native_scheme"],
            self.source_basis,
        )

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        units = self._checked_job(job)
        text = self.source.checked_text(storage)
        if self.reader:
            return self._reader_unit(storage, text, units)
        return prepare_text(
            self.source.identity(storage),
            self.source.select(text, units),
            {"source_basis": self.source_basis},
        )

    def read_source(self, revision: str, storage: Any) -> NativeText:
        if revision != self.source.revision:
            raise RecordError("Quality asked for another source revision")
        return self.source.checked_text(storage)

    def read_reader_references(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        units = self._checked_job(job)
        groups = [
            entry["native_extent"]["unit_ids"]
            for entry in self.recipe["units"]
            if entry["kind"] == "prepare"
        ]
        if [unit for group in groups for unit in group] != units:
            raise RecordError("USFM reader partition differs from the quality extent")
        text = self.source.checked_text(storage)
        records = RecordSet()
        for group in groups:
            records.merge(self._reader_unit(storage, text, group))
        return records

"""STEPBible tagged-text adapter (TAHOT Hebrew OT, TAGNT Greek NT).

One recipe covers one book: prepare units of whole verses sized for one D1 batch each, and a
quality unit over the book. Fetching the pinned component file is a separate recipe (`fetch.py`)
that one fetch of a file serves for every book in it. The adapter code is generic; the recipe
pins the exact file.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from ...prepare.evidence import NativeText
from ...prepare.records import RecordError, RecordSet
from .. import AdapterDeclaration, AdapterRegistry
from .prepare import (
    METHOD_VERSION,
    book_text,
    book_verses,
    prepare_unit,
    read_component,
)
from .reader_references import READER_REFERENCE, prepare_reader_reference_unit
from .source import Component

INPUT_FORMAT = "stepbible/tagged-tsv"
CAPABILITIES = (
    "source_context",
    "word_exact",
    "form_exact",
    "lemma_exact",
    "grammar_exact",
)
DECLARATION = AdapterDeclaration(
    "stepbible-tagged",
    METHOD_VERSION,
    frozenset({INPUT_FORMAT}),
    frozenset((*CAPABILITIES, READER_REFERENCE)),
    frozenset(
        {
            "source",
            "commit",
            "component",
            "path",
            "sha256",
            "byte_count",
            "source_profile",
        }
    ),
    (
        "Verses follow the declared base text; other readings are annotations, not alternative texts",
        "Paragraph markers are kept in the wording but are not yet literary-unit spans",
        "Word analyses are the source's own tags, attributed to STEPBible.org",
    ),
)


def registry() -> AdapterRegistry:
    adapters = AdapterRegistry()
    adapters.register(DECLARATION)
    return adapters


@dataclass(frozen=True)
class BookRecipe:
    """Module entry points for one reviewed STEPBible book recipe."""

    recipe: Mapping[str, Any]
    component: Component
    book: str

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> "BookRecipe":
        registry().resolve(dict(recipe))
        component = Component.from_parameters(recipe["parameters"])
        extent = recipe["native_extent"]
        book = extent.get("book")
        if (
            book not in component.source.books
            or set(extent) != {"book", "coordinate_version"}
            or extent["coordinate_version"] != component.coordinate_version
            or recipe.get("dependencies") != [component.acquisition_id]
            or recipe.get("task_inputs") != component.task_inputs()
        ):
            raise RecordError(
                f"Recipe {recipe['id']} does not match its STEPBible component"
            )
        if READER_REFERENCE in recipe["capabilities"] and set(
            recipe["capabilities"]
        ) != {READER_REFERENCE}:
            raise RecordError("Use a separate recipe for reader-reference outputs")
        return cls(recipe, component, book)

    @property
    def maps_reader_references(self) -> bool:
        return READER_REFERENCE in self.recipe["capabilities"]

    # Gate --------------------------------------------------------------------
    def _original(self, storage: Any) -> bytes:
        try:
            return self.component.check_original(
                storage.read_blob(self.component.original_key)
            )
        except KeyError:
            raise RecordError("The original has not been acquired") from None

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        self.component.check_inputs(job)
        extent = job["native_extent"]
        if extent.get("coordinate_version") != self.component.coordinate_version:
            raise RecordError("Prepare unit uses other coordinates")
        if self.maps_reader_references:
            self._check_mapping_unit(job)
            return prepare_reader_reference_unit(
                self._original(storage), self.component, self.book, extent["unit_ids"]
            )
        return prepare_unit(
            self._original(storage),
            self.component,
            self.book,
            extent.get("unit_ids") or [],
        )

    def _check_mapping_unit(self, job: Mapping[str, Any]) -> None:
        if not any(
            unit["unit_id"] == job["unit_id"]
            and unit["kind"] == job["kind"]
            and unit["native_extent"] == job["native_extent"]
            for unit in self.recipe.get("units", ())
        ):
            raise RecordError(
                "Reader-reference job does not match a reviewed recipe unit"
            )

    def read_reader_references(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        """Rebuild expected mappings from pinned input and the reviewed prepare partition."""
        self.component.check_inputs(job)
        self._check_mapping_unit(job)
        partition = [
            unit["native_extent"]["unit_ids"]
            for unit in self.recipe["units"]
            if unit["kind"] == "prepare"
        ]
        unit_ids = [unit_id for group in partition for unit_id in group]
        wanted = job["native_extent"]["unit_ids"]
        if len(set(unit_ids)) != len(unit_ids) or set(unit_ids) != set(wanted):
            raise RecordError(
                "Reader-reference partition does not match the quality extent"
            )
        data = self._original(storage)
        records = RecordSet()
        for group in partition:
            records.merge(
                prepare_reader_reference_unit(data, self.component, self.book, group)
            )
        return records

    def read_source(self, revision: str, storage: Any) -> NativeText:
        if revision != self.component.revision_id:
            raise RecordError("Quality asked for another source revision")
        words = read_component(self._original(storage), self.component)
        return book_text(
            book_verses(words, self.component, self.book), self.component, self.book
        )

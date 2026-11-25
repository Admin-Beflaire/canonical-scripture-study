"""Fetch one pinned STEPBible-Data file: keep the original and register its source and admission.

A fetch recipe covers one component file. A book recipe (`__init__.py`) builds from the saved
original, so one fetch serves every book in the file and either can run on its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from ...acquire.fetch import fetch_original
from ...acquire.transfer import Route
from ...prepare.records import RecordError, RecordSet
from .. import AdapterDeclaration, AdapterRegistry
from . import INPUT_FORMAT
from .source import RAW_HOST, Component

DECLARATION = AdapterDeclaration(
    "stepbible-fetch",
    "stepbible-fetch/1",
    frozenset({INPUT_FORMAT}),
    frozenset(),
    frozenset({"source", "commit", "component", "path", "sha256", "byte_count"}),
)


@dataclass(frozen=True)
class ComponentFetch:
    """Module entry points for one reviewed STEPBible component fetch recipe."""

    recipe: Mapping[str, Any]
    component: Component

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> "ComponentFetch":
        registry = AdapterRegistry()
        registry.register(DECLARATION)
        registry.resolve(dict(recipe))
        component = Component.from_parameters(recipe["parameters"])
        if (
            recipe["native_extent"] != {"component": component.component}
            or recipe["capabilities"] != []
            or recipe.get("dependencies") != [component.acquisition_id]
            or [(unit["unit_id"], unit["kind"]) for unit in recipe["units"]]
            != [("acquire", "acquire")]
        ):
            raise RecordError(
                f"Recipe {recipe['id']} does not match its STEPBible component"
            )
        return cls(recipe, component)

    def declares(self, reference: Mapping[str, Any], kind: str) -> bool:
        """Inputs this reviewed recipe vouches for before they are saved: the acquisition route,
        and the source revision that fetching creates."""
        return self.component.declares_acquisition(reference) or (
            reference.get("kind") == "source_revision"
            and reference.get("id") == self.component.revision_id
            and set(reference) == {"kind", "id"}
        )

    def acquire(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        """Retain the pinned original privately and register its source and admission records."""
        component = self.component
        component.check_inputs(job)
        key = component.original_key
        try:
            component.check_original(storage.read_blob(key))
        except (KeyError, RecordError):
            route = Route(
                component.acquisition_id,
                component.url,
                frozenset({RAW_HOST}),
                component.byte_count,
                component.sha256,
            )
            data, _ = fetch_original(route)
            data = component.check_original(data)
            storage.put_blob(key, data)
            component.check_original(storage.read_blob(key))
        records = RecordSet()
        for row in component.identity().rows():
            records.add("source_node", row)
        records.add("admission", component.admission_row())
        return records

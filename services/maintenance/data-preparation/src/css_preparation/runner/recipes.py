"""Fixed, reviewed registry from a job's `recipe_revision` to Preparation modules.

Jobs select a registered recipe by identity; they never name modules, scripts or
branches. The registry is built from the reviewed recipe files in `collection/recipes/`
(the same files Control reads from main) and the declared adapters. An unknown recipe is
refused; a recipe file that does not resolve stops the runner rather than being skipped.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Callable, Mapping

from ..adapters.stepbible import DECLARATION as STEPBIBLE, BookRecipe
from ..adapters.stepbible.fetch import DECLARATION as STEPBIBLE_FETCH, ComponentFetch
from ..adapters.acquire_only import DECLARATION as ACQUIRE_ONLY, AcquireRecipe
from ..adapters.step_aids import DECLARATION as LANGUAGE_AIDS, AidRecipe
from ..prepare.evidence import NativeText
from ..prepare.records import RecordSet
from ..validation import SCHEMAS

RECIPE_DIRECTORY = SCHEMAS.parent / "collection" / "recipes"


@dataclass(frozen=True)
class Recipe:
    """Module entry points for one recipe revision. `storage` is the run's CloudflareStorage.

    `declares(reference, kind)` vouches for job inputs that are declared by the reviewed
    recipe but not yet saved (an acquisition route; the source revision its acquire unit creates).
    """

    acquire: Callable[[dict[str, Any], Any], RecordSet] | None = None
    prepare: Callable[[dict[str, Any], Any], RecordSet] | None = None
    read_source: Callable[[str, Any], NativeText] | None = None
    declares: Callable[[Mapping[str, Any], str], bool] | None = None
    read_reader_references: Callable[[Mapping[str, Any], Any], RecordSet] | None = None
    read_aid_entries: Callable[[Mapping[str, Any], Any], RecordSet] | None = None


def load_recipes(directory: Path = RECIPE_DIRECTORY) -> dict[str, Recipe]:
    recipes: dict[str, Recipe] = {}
    for path in sorted(directory.glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or path.stem != value.get("id"):
            raise ValueError(
                f"Recipe file {path.name} does not hold recipe {path.stem}"
            )
        adapter = value.get("adapter", {})
        identity = (adapter.get("name"), adapter.get("method_version"))
        if value["revision"] in recipes:
            raise ValueError(f"Recipe revision {value['revision']} is declared twice")
        if identity == (STEPBIBLE.name, STEPBIBLE.method_version):
            book = BookRecipe.from_recipe(value)
            recipes[value["revision"]] = Recipe(
                prepare=book.prepare,
                read_source=book.read_source,
                declares=book.declares,
                read_reader_references=book.read_reader_references
                if book.maps_reader_references
                else None,
            )
        elif identity == (STEPBIBLE_FETCH.name, STEPBIBLE_FETCH.method_version):
            fetch = ComponentFetch.from_recipe(value)
            recipes[value["revision"]] = Recipe(
                acquire=fetch.acquire, declares=fetch.declares
            )
        elif identity == (ACQUIRE_ONLY.name, ACQUIRE_ONLY.method_version):
            source = AcquireRecipe.from_recipe(value)
            recipes[value["revision"]] = Recipe(
                acquire=source.acquire, declares=source.declares
            )
        elif identity == (LANGUAGE_AIDS.name, LANGUAGE_AIDS.method_version):
            source = AidRecipe.from_recipe(value)
            recipes[value["revision"]] = Recipe(
                prepare=source.prepare,
                read_source=source.read_source,
                read_aid_entries=source.read_aid_entries,
            )
        else:
            raise ValueError(f"Recipe {path.stem} names no registered adapter")
    return recipes


RECIPES: dict[str, Recipe] = load_recipes()

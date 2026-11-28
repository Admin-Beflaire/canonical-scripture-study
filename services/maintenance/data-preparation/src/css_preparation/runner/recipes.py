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

from ..adapters import AdapterDeclaration
from ..adapters.usfm import DECLARATION as USFM, UsfmRecipe
from ..adapters.stepbible import DECLARATION as STEPBIBLE, BookRecipe
from ..adapters.stepbible.fetch import DECLARATION as STEPBIBLE_FETCH, ComponentFetch
from ..adapters.acquire_only import DECLARATION as ACQUIRE_ONLY, AcquireRecipe
from ..adapters.step_aids import DECLARATION as LANGUAGE_AIDS, AidRecipe
from ..adapters.character_statement import (
    DECLARATION as CHARACTER_STATEMENT,
    StatementRecipe,
)
from ..prepare.evidence import NativeText
from ..prepare.records import RecordSet
from ..validation import SCHEMAS

RECIPE_DIRECTORY = SCHEMAS.parent / "collection" / "recipes"


@dataclass(frozen=True)
class Recipe:
    """Module entry points for one recipe revision. `storage` is the run's CloudflareStorage.

    `declares(reference, kind)` is a fetch recipe's own inputs that are not saved: its
    acquisition route, and the source revision its acquire unit creates.
    """

    acquire: Callable[[dict[str, Any], Any], RecordSet] | None = None
    prepare: Callable[[dict[str, Any], Any], RecordSet] | None = None
    read_source: Callable[[str, Any], NativeText] | None = None
    declares: Callable[[Mapping[str, Any], str], bool] | None = None
    read_reader_references: Callable[[Mapping[str, Any], Any], RecordSet] | None = None
    read_aid_entries: Callable[[Mapping[str, Any], Any], RecordSet] | None = None
    read_statements: Callable[[Mapping[str, Any], Any], RecordSet] | None = None
    read_original: Callable[[Mapping[str, Any], Any], tuple[bytes, str]] | None = None


def _step_book(value: Mapping[str, Any]) -> Recipe:
    book = BookRecipe.from_recipe(value)
    return Recipe(
        prepare=book.prepare,
        read_source=book.read_source,
        read_reader_references=book.read_reader_references
        if book.maps_reader_references
        else None,
    )


def _usfm_book(value: Mapping[str, Any]) -> Recipe:
    book = UsfmRecipe.from_recipe(value)
    return Recipe(
        prepare=book.prepare,
        read_source=book.read_source,
        read_reader_references=book.read_reader_references if book.reader else None,
    )


def _fetch(fetch: AcquireRecipe | ComponentFetch) -> Recipe:
    return Recipe(
        acquire=fetch.acquire,
        declares=fetch.declares,
        read_original=fetch.read_original,
    )


def _aid(value: Mapping[str, Any]) -> Recipe:
    source = AidRecipe.from_recipe(value)
    return Recipe(
        prepare=source.prepare,
        read_source=source.read_source,
        read_aid_entries=source.read_aid_entries,
    )


def _statement(value: Mapping[str, Any]) -> Recipe:
    statement = StatementRecipe.from_recipe(value)
    return Recipe(
        prepare=statement.prepare,
        read_source=statement.read_source,
        read_statements=statement.read_statements,
    )


def _key(adapter: AdapterDeclaration) -> tuple[str, str]:
    return adapter.name, adapter.method_version


ADAPTERS = {
    _key(STEPBIBLE): _step_book,
    _key(STEPBIBLE_FETCH): lambda value: _fetch(ComponentFetch.from_recipe(value)),
    _key(ACQUIRE_ONLY): lambda value: _fetch(AcquireRecipe.from_recipe(value)),
    _key(LANGUAGE_AIDS): _aid,
    _key(CHARACTER_STATEMENT): _statement,
    _key(USFM): _usfm_book,
}


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
        bind = ADAPTERS.get(identity)
        if bind is None:
            raise ValueError(f"Recipe {path.stem} names no registered adapter")
        recipes[value["revision"]] = bind(value)
    return recipes


RECIPES: dict[str, Recipe] = load_recipes()


def declared_input(
    reference: Mapping[str, Any],
    kind: str,
    recipe: Recipe | None,
    recipes: Mapping[str, Recipe],
) -> bool:
    """Does a reviewed recipe vouch for a job input that is not saved?

    The unit's own recipe declares what its acquire unit reads and creates. An acquisition
    route is never saved: it counts when any reviewed fetch recipe declares it (DP-05).
    Control gives every unit of a task all its inputs, so the build units of a task that
    fetches first name that route too.
    """

    def declares(candidate: Recipe | None, unit_kind: str) -> bool:
        return (
            candidate is not None
            and candidate.declares is not None
            and candidate.declares(reference, unit_kind)
        )

    return declares(recipe, kind) or (
        reference.get("kind") == "acquisition"
        and any(declares(other, "acquire") for other in recipes.values())
    )

"""Regenerate committed recipe files from reviewed variables without source bytes."""

from __future__ import annotations

from pathlib import Path
import re
import sys
from typing import Any, Iterator

from .adapters.stepbible.recipes import book_recipe, dumps, fetch_recipe
from .adapters.stepbible.source import Component
from .adapters.usfm import CAPABILITIES as USFM_CAPABILITIES, DECLARATION as USFM
from .adapters.usfm.source import book_units, preparation_basis
from .recipe_source import COLLECTION, DIRECTORY, read_json
from .recipe_templates import (
    fetch_template,
    native_units,
    reader_template,
    text_template,
)

GENERATED = re.compile(r"stepbible-(?:tahot-|tagnt-|fetch-)|web-usfm-2020(?:-|$)")


def _step_recipes(source: dict[str, Any]) -> Iterator[dict[str, Any]]:
    profile = source.get("profile", "1")
    variables = source["profiles"][profile]
    components = {
        key: Component.from_parameters(
            {
                **values,
                "source": variables["key"],
                "source_profile": profile,
                "commit": source["commit"],
                "component": key,
            }
        )
        for key, values in source["components"].items()
    }
    revision = source["recipe_revision"]
    for component in components.values():
        yield fetch_recipe(component, revision)
    if tuple(variables["books"]) != tuple(source["books"]):
        raise ValueError("STEPBible book extents must follow the declared book order")
    for book, config in source["books"].items():
        component = components[config["component"]]
        units = native_units(book, config["chapters"])
        yield book_recipe(
            component, book, units, revision=config.get("revision", revision)
        )
        yield book_recipe(
            component,
            book,
            units,
            revision=config.get("reader_revision", revision),
            joins=config.get("reader_join_groups", []),
        )


def _usfm_book(
    name: str, source: dict[str, Any], manifest: dict[str, Any], book: str, reader: bool
) -> dict[str, Any]:
    cfg = source["books"][book]
    units = book_units(book, cfg)
    recipe_id = f"{name}-{book.lower()}" + ("-reader" if reader else "")
    revision = cfg.get("reader_revision" if reader else "revision", source["revision"])
    recipe = {
        "id": recipe_id,
        "revision": f"{recipe_id}/{revision}",
        "adapter": {"name": USFM.name, "method_version": USFM.method_version},
        "input_format": "archive/usfm",
        "parameters": {
            "variables": name,
            "archive_sha256": source["analysis_report"]["archive_sha256"],
            "member_sha256": cfg["sha256"],
            "basis_sha256": preparation_basis(source, manifest, book, reader),
        },
        "native_extent": {
            "book": book,
            "coordinate_version": source["coordinate_version"],
        },
        "capabilities": list(USFM_CAPABILITIES),
        "dependencies": [manifest["manifest_revision"]],
        "task_inputs": [
            {"kind": "acquisition", "id": manifest["manifest_revision"]},
            {"kind": "source_revision", "id": manifest["source_revision"]},
        ],
        "manifest_revision": manifest["manifest_revision"],
    }
    if not reader:
        return text_template(recipe, units)
    joined = [
        list(dict.fromkeys(segment[0] for segment in link["segments"]))
        for link in cfg["reader_mapping"]["links"].values()
    ]
    return reader_template(recipe, units, [group for group in joined if len(group) > 1])


def _usfm_recipes(name: str, source: dict[str, Any]) -> Iterator[dict[str, Any]]:
    manifest = read_json(COLLECTION / "manifests" / source["manifest"])
    yield fetch_template(
        {
            "id": name,
            "revision": manifest["manifest_revision"],
            "adapter": {"name": "acquire-only", "method_version": "acquire-only/1"},
            "input_format": "archive/opaque",
            "parameters": {"manifest": source["manifest"]},
            "native_extent": {"component": manifest["source_revision"]},
            "dependencies": [manifest["manifest_revision"]],
            "manifest_revision": manifest["manifest_revision"],
        }
    )
    for book, config in source["books"].items():
        yield _usfm_book(name, source, manifest, book, reader=False)
        if "reader_mapping" in config:
            yield _usfm_book(name, source, manifest, book, reader=True)


def generated_recipes(directory: Path = DIRECTORY) -> dict[str, dict[str, Any]]:
    recipes: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("*.json")):
        source = read_json(path)
        if source["kind"] == "stepbible-tagged":
            items = _step_recipes(source)
        elif source["kind"] == "usfm-text":
            items = _usfm_recipes(path.stem, source)
        else:
            raise ValueError(f"Unknown recipe variables format in {path.name}")
        for recipe in items:
            name = recipe["id"]
            if name in recipes:
                raise ValueError(f"Recipe {name} is generated twice")
            recipes[name] = recipe
    return recipes


def committed_generated(collection: Path = COLLECTION) -> dict[str, dict[str, Any]]:
    return {
        path.stem: read_json(path)
        for path in (collection / "recipes").glob("*.json")
        if GENERATED.match(path.stem)
    }


def main() -> None:
    """Update generated files while leaving standalone recipes alone."""
    generated = generated_recipes()
    existing = committed_generated()
    for name in sorted(existing.keys() - generated.keys()):
        print(f"Remove retired generated recipe: {name}.json", file=sys.stderr)
    for name, recipe in generated.items():
        if existing.get(name) != recipe:
            (COLLECTION / "recipes" / f"{name}.json").write_text(
                dumps(recipe), encoding="utf-8"
            )


if __name__ == "__main__":
    main()

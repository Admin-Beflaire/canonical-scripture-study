"""Bind STEPBible source variables to the shared recipe templates."""

from __future__ import annotations

import json
import re
from typing import Any

from . import CAPABILITIES, INPUT_FORMAT
from .prepare import METHOD_VERSION
from .source import LICENCE, Component

from ...recipe_templates import (
    MAX_PREPARE_UNITS as MAX_PREPARE_UNITS,
    MAX_VERSES as MAX_VERSES,
    fetch_template,
    reader_template,
    text_template,
)


def manifest_revision(commit: str) -> str:
    return f"stepbible-data:{commit[:12]}"


def pinned(component: Component) -> dict[str, Any]:
    """The pinned file, as every recipe over it states it."""
    return {
        "source": component.source.key,
        "commit": component.commit,
        "component": component.component,
        "path": component.path,
        "sha256": component.sha256,
        "byte_count": component.byte_count,
        **({"source_profile": component.profile} if component.profile != "1" else {}),
    }


def book_recipe(
    component: Component,
    book: str,
    unit_ids: list[str],
    *,
    revision: int = 3,
    joins: list[list[str]] | None = None,
) -> dict[str, Any]:
    recipe_id = f"stepbible-{component.source.key}-{book.lower()}"
    if joins is not None:
        recipe_id += "-reader"
    recipe = {
        "id": recipe_id,
        "revision": f"{recipe_id}/{component.commit[:12]}/{revision}",
        "adapter": {"name": "stepbible-tagged", "method_version": METHOD_VERSION},
        "input_format": INPUT_FORMAT,
        "parameters": pinned(component),
        "native_extent": {
            "book": book,
            "coordinate_version": component.coordinate_version,
        },
        "capabilities": list(CAPABILITIES),
        "dependencies": [component.acquisition_id],
        "task_inputs": component.task_inputs(),
        "manifest_revision": manifest_revision(component.commit),
    }
    if joins is not None:
        return reader_template(recipe, unit_ids, joins)
    return text_template(recipe, unit_ids)


def admission_record(component: Component) -> dict[str, Any]:
    """What a fetch of this file records about its admission, stated in the fetch recipe."""
    return {
        "terms_basis": f"{LICENCE} licence notice in {component.path} at STEPBible-Data commit {component.commit}",
        "permitted_uses": [
            "acquire",
            "retain",
            "backup",
            "prepare",
            "chatgpt",
            "claude",
        ],
        "restrictions": [
            "Attribute Tyndale House and STEPBible.org with a link to "
            "STEPBible.github.io/STEPBible-Data",
            "Make changes to the data visible to its users",
        ],
        "notices": [
            component.identity().attribution,
            "STEPBible asks: please do not post copies of this data file elsewhere, "
            "so that it remains the single up-to-date source",
        ],
        "both_hosts_eligible": True,
        "public_redistribution": "allowed",
    }


def fetch_recipe(component: Component, revision: int = 3) -> dict[str, Any]:
    recipe_id = f"stepbible-fetch-{component.component}"
    return fetch_template(
        {
            "id": recipe_id,
            "revision": f"{recipe_id}/{component.commit[:12]}/{revision}",
            "adapter": {
                "name": "stepbible-fetch",
                "method_version": "stepbible-fetch/1",
            },
            "input_format": INPUT_FORMAT,
            "parameters": {
                **pinned(component),
                "admission_record": admission_record(component),
            },
            "native_extent": {"component": component.component},
            "dependencies": [component.acquisition_id],
            "task_inputs": component.task_inputs(),
            "manifest_revision": manifest_revision(component.commit),
        }
    )


def dumps(value: dict[str, Any]) -> str:
    """Two-space JSON with each verse list on one line, so diffs stay readable."""
    text = json.dumps(value, ensure_ascii=False, indent=2)
    return (
        re.sub(
            r'"unit_ids": \[\s*([^\]]*?)\s*\]',
            lambda match: (
                '"unit_ids": [' + ", ".join(re.split(r",\s*", match[1])) + "]"
            ),
            text,
        )
        + "\n"
    )

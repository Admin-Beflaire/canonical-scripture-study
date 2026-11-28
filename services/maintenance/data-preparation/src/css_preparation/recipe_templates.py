"""Development-time templates for the three generated recipe kinds."""

from collections.abc import Sequence
from typing import Any

MAX_VERSES = 300
MAX_PREPARE_UNITS = 12  # Keep the quality job below its dependency reference limit.


def native_units(book: str, chapters: dict[str, str]) -> list[str]:
    units = []
    for chapter, labels in chapters.items():
        for label in labels.split(","):
            bounds = [int(part) for part in label.split("-")]
            if len(bounds) > 2 or not 0 <= bounds[0] <= bounds[-1] or int(chapter) < 1:
                raise ValueError(f"Invalid native range {book}.{chapter}.{label}")
            units.extend(
                f"{book}.{chapter}.{verse}"
                for verse in range(bounds[0], bounds[-1] + 1)
            )
    return units


def _reader_boundaries(
    units: Sequence[str], boundaries: list[int], joins: Sequence[Sequence[str]]
) -> list[int]:
    positions = {unit: position for position, unit in enumerate(units)}
    for group in joins:
        members = [positions[unit] for unit in group]
        first, last = min(members), max(members)
        group_start = first
        chapter = units[first].rsplit(".", 1)[0]
        while first and units[first - 1].rsplit(".", 1)[0] == chapter:
            first -= 1
        for index, boundary in enumerate(boundaries):
            if group_start < boundary <= last:
                boundaries[index] = first
    return boundaries


def _partition(units: Sequence[str], joins: Sequence[Sequence[str]]) -> list[list[str]]:
    if not units or len(set(units)) != len(units):
        raise ValueError("A recipe needs a nonempty, distinct native extent")
    if any(len(group) < 2 or len(set(group)) != len(group) for group in joins):
        raise ValueError("A reader join needs distinct native contributors")
    parts = -(-len(units) // MAX_VERSES)
    size = -(-len(units) // parts)
    boundaries = _reader_boundaries(units, list(range(size, len(units), size)), joins)
    ends = [0, *boundaries, len(units)]
    groups = [
        list(units[start:end]) for start, end in zip(ends[:-1], ends[1:], strict=True)
    ]
    if len(groups) > MAX_PREPARE_UNITS or any(
        not 0 < len(group) <= MAX_VERSES for group in groups
    ):
        raise ValueError("Native extent exceeds the prepare partition limits")
    membership = {unit: index for index, group in enumerate(groups) for unit in group}
    if any(len({membership[unit] for unit in join}) != 1 for join in joins):
        raise ValueError("Prepare partition splits a reader reference")
    return groups


def fetch_template(recipe: dict[str, Any]) -> dict[str, Any]:
    extent = recipe["native_extent"]
    return {
        "recipe_version": "preparation-recipe/1",
        **recipe,
        "capabilities": [],
        "units": [
            {
                "unit_id": "acquire",
                "kind": "acquire",
                "native_extent": extent,
                "depends_on": [],
            }
        ],
    }


def _book_template(
    recipe: dict[str, Any], units: list[str], joins: Sequence[Sequence[str]]
) -> dict[str, Any]:
    coordinate = recipe["native_extent"]["coordinate_version"]
    prepare = [
        {
            "unit_id": f"prepare-{index:02d}",
            "kind": "prepare",
            "native_extent": {"coordinate_version": coordinate, "unit_ids": group},
            "depends_on": [],
        }
        for index, group in enumerate(_partition(units, joins), start=1)
    ]
    return {
        "recipe_version": "preparation-recipe/1",
        **recipe,
        "units": [
            *prepare,
            {
                "unit_id": "quality",
                "kind": "quality",
                "native_extent": {"coordinate_version": coordinate, "unit_ids": units},
                "depends_on": [unit["unit_id"] for unit in prepare],
                "required_capabilities": recipe["capabilities"],
            },
        ],
    }


def text_template(recipe: dict[str, Any], units: list[str]) -> dict[str, Any]:
    return _book_template(recipe, units, ())


def reader_template(
    recipe: dict[str, Any], units: list[str], joins: Sequence[Sequence[str]]
) -> dict[str, Any]:
    return _book_template(
        {**recipe, "capabilities": ["reader_reference"]}, units, joins
    )

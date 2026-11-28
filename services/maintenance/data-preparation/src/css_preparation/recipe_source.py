"""Committed source variables shared by recipe generation and Preparation."""

from functools import lru_cache
import json
from pathlib import Path
from typing import Any

from .validation import SCHEMAS

COLLECTION = SCHEMAS.parent / "collection"
DIRECTORY = COLLECTION / "recipe-sources"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache
def source_variables(name: str) -> dict[str, Any]:
    return read_json(DIRECTORY / f"{name}.json")

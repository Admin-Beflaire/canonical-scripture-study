"""Fixed, reviewed registry from a job's `recipe_revision` to Preparation modules.

Jobs select a registered recipe by identity; they never name modules, scripts or
branches. The registry is empty until the first admitted-source adapters (DP-05)
register here through a reviewed pull request. An unknown recipe is refused.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..prepare.evidence import NativeText
from ..prepare.records import RecordSet


@dataclass(frozen=True)
class Recipe:
    """Module entry points for one recipe revision. `storage` is the run's CloudflareStorage."""

    acquire: Callable[[dict[str, Any], Any], RecordSet] | None = None
    prepare: Callable[[dict[str, Any], Any], RecordSet] | None = None
    read_source: Callable[[str, Any], NativeText] | None = None


RECIPES: dict[str, Recipe] = {}

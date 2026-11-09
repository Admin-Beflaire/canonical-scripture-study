"""Format adapters: declarations, a registry and declarative recipe resolution.

Adapters declare what they accept and produce; recipes in `collection/recipes/` choose an
adapter, version, parameters and extent. No source choice is made in code.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from ..validation import SchemaSubset

_RECIPES = SchemaSubset('maintenance/recipe.v1.schema.json')


class RecipeError(ValueError):
    """A recipe cannot be resolved to a declared adapter."""


@dataclass(frozen=True)
class AdapterDeclaration:
    name: str
    method_version: str
    accepts: frozenset[str]
    capabilities: frozenset[str]
    parameters: frozenset[str] = frozenset()
    limitations: tuple[str, ...] = ()


@dataclass
class AdapterRegistry:
    _adapters: dict[tuple[str, str], AdapterDeclaration] = field(default_factory=dict)

    def register(self, declaration: AdapterDeclaration) -> AdapterDeclaration:
        key = (declaration.name, declaration.method_version)
        if key in self._adapters:
            raise ValueError(f'Adapter {declaration.name} {declaration.method_version} is already declared')
        self._adapters[key] = declaration
        return declaration

    def declarations(self) -> Iterable[AdapterDeclaration]:
        return tuple(self._adapters.values())

    def resolve(self, recipe: dict[str, Any]) -> AdapterDeclaration:
        """Return the declared adapter for a valid recipe, or explain why it does not fit."""
        errors = _RECIPES.errors('recipe', recipe)
        if errors:
            raise RecipeError('Invalid recipe: ' + '; '.join(errors[:5]))
        wanted = (recipe['adapter']['name'], recipe['adapter']['method_version'])
        adapter = self._adapters.get(wanted)
        if adapter is None:
            raise RecipeError(f'No declared adapter {wanted[0]} {wanted[1]}')
        problems = []
        if recipe['input_format'] not in adapter.accepts:
            problems.append(f"input format {recipe['input_format']} is not accepted")
        missing = sorted(set(recipe['capabilities']) - adapter.capabilities)
        if missing:
            problems.append('capabilities not offered: ' + ', '.join(missing))
        unknown = sorted(set(recipe['parameters']) - adapter.parameters)
        if unknown:
            problems.append('unknown parameters: ' + ', '.join(unknown))
        if problems:
            raise RecipeError(f'Recipe {recipe["id"]} does not fit {wanted[0]} {wanted[1]}: ' + '; '.join(problems))
        return adapter

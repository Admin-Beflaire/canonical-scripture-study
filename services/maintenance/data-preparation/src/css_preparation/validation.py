"""Runtime validation of the small JSON Schema keyword subset used by `schemas/`.

Any other keyword is rejected, so the schema files stay the single source of truth for
both Python and the TypeScript Workers. Standard library only.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

SCHEMAS = Path(__file__).resolve().parents[5] / 'schemas'
_SUPPORTED = {'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'required',
              'properties', 'additionalProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', '$ref',
              'anyOf', 'oneOf', 'allOf', 'if', 'then', 'else'}
# Annotations carry no validation meaning.
_ANNOTATIONS = {'$schema', '$id', '$defs', 'title', 'description'}
_IDENTIFIED: dict[str, dict[str, Any]] | None = None


def _identified() -> dict[str, dict[str, Any]]:
    """Schema files by `$id`, for references such as `urn:css:native-reference:1`."""
    global _IDENTIFIED
    if _IDENTIFIED is None:
        found = {}
        for path in sorted(SCHEMAS.rglob('*.json')):
            document = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(document, dict) and isinstance(document.get('$id'), str):
                found[document['$id']] = document
        _IDENTIFIED = found
    return _IDENTIFIED


def _pointer(document: dict[str, Any], fragment: str, reference: str) -> dict[str, Any]:
    target: Any = document
    if fragment:
        if not fragment.startswith('/'):
            raise RuntimeError(f'Unknown schema reference {reference}')
        for part in fragment[1:].split('/'):
            part = part.replace('~1', '/').replace('~0', '~')
            if not isinstance(target, dict) or part not in target:
                raise RuntimeError(f'Unknown schema reference {reference}')
            target = target[part]
    if not isinstance(target, dict):
        raise RuntimeError(f'Unknown schema reference {reference}')
    return target


class SchemaSubset:
    """Validate values against the named `$defs` of one schema file."""

    def __init__(self, relative_path: str):
        self._document: dict[str, Any] = json.loads((SCHEMAS / relative_path).read_text(encoding='utf-8'))
        self._DEFS: dict[str, dict[str, Any]] = self._document.get('$defs', {})

    def errors(self, name: str, value: Any) -> list[str]:
        if name not in self._DEFS:
            raise ValueError(name)
        found: list[str] = []
        self._check(self._DEFS[name], value, '$', found, self._document)
        return found

    def document_errors(self, value: Any) -> list[str]:
        """Validate against the whole schema file rather than one named definition."""
        found: list[str] = []
        self._check(self._document, value, '$', found, self._document)
        return found

    @staticmethod
    def _type_of(value: Any) -> str:
        if value is None:
            return 'null'
        if isinstance(value, bool):
            return 'boolean'
        if isinstance(value, int):
            return 'integer'
        if isinstance(value, float):
            return 'integer' if value.is_integer() else 'number'
        if isinstance(value, str):
            return 'string'
        if isinstance(value, list):
            return 'array'
        if isinstance(value, dict):
            return 'object'
        return 'unknown'

    def _resolve(self, reference: str, document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        base, _, fragment = reference.partition('#')
        if base:
            target_document = _identified().get(base)
            if target_document is None:
                raise RuntimeError(f'Unknown schema reference {reference}')
        else:
            target_document = document
        return _pointer(target_document, fragment, reference), target_document

    def _matches(self, schema: dict[str, Any], value: Any, document: dict[str, Any]) -> bool:
        probe: list[str] = []
        self._check(schema, value, '$', probe, document)
        return not probe

    def _check(self, schema: dict[str, Any], value: Any, path: str, errors: list[str],
               document: dict[str, Any]) -> None:
        unknown = set(schema) - _SUPPORTED - _ANNOTATIONS
        if unknown:
            raise RuntimeError(f'Unsupported schema keyword {sorted(unknown)[0]}')
        if '$ref' in schema:
            target, target_document = self._resolve(schema['$ref'], document)
            self._check(target, value, path, errors, target_document)
            return
        if 'anyOf' in schema and not any(self._matches(option, value, document) for option in schema['anyOf']):
            errors.append(f'{path}: matches no allowed form')
        if 'oneOf' in schema and sum(self._matches(option, value, document) for option in schema['oneOf']) != 1:
            errors.append(f'{path}: must match exactly one form')
        for option in schema.get('allOf', ()):
            self._check(option, value, path, errors, document)
        if 'if' in schema:
            branch = schema.get('then') if self._matches(schema['if'], value, document) else schema.get('else')
            if branch is not None:
                self._check(branch, value, path, errors, document)
        actual = self._type_of(value)
        if 'type' in schema:
            allowed = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
            if actual not in allowed and not (actual == 'integer' and 'number' in allowed):
                errors.append(f"{path}: expected {' or '.join(allowed)}")
                return
        if 'const' in schema and (value != schema['const'] or self._type_of(value) != self._type_of(schema['const'])):
            errors.append(f"{path}: must be {schema['const']}")
        if 'enum' in schema and not any(value == item and self._type_of(value) == self._type_of(item)
                                        for item in schema['enum']):
            errors.append(f'{path}: not an allowed value')
        if isinstance(value, str):
            if 'minLength' in schema and len(value) < schema['minLength']:
                errors.append(f'{path}: too short')
            if 'maxLength' in schema and len(value) > schema['maxLength']:
                errors.append(f'{path}: too long')
            # Schema patterns are anchored; fullmatch also rejects a trailing newline, as JavaScript does.
            if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
                errors.append(f'{path}: invalid format')
        if actual in ('integer', 'number'):
            if 'minimum' in schema and value < schema['minimum']:
                errors.append(f'{path}: below minimum')
            if 'maximum' in schema and value > schema['maximum']:
                errors.append(f'{path}: above maximum')
        if actual == 'array':
            if schema.get('uniqueItems') and len({json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(',', ':')) for item in value}) != len(value):
                errors.append(f'{path}: array items must be unique')
            if 'minItems' in schema and len(value) < schema['minItems']:
                errors.append(f'{path}: too few items')
            if 'maxItems' in schema and len(value) > schema['maxItems']:
                errors.append(f'{path}: too many items')
            if 'items' in schema:
                for index, item in enumerate(value):
                    self._check(schema['items'], item, f'{path}[{index}]', errors, document)
        if actual == 'object':
            properties = schema.get('properties', {})
            if 'maxProperties' in schema and len(value) > schema['maxProperties']:
                errors.append(f'{path}: too many fields')
            for name in schema.get('required', []):
                if name not in value:
                    errors.append(f'{path}.{name}: required')
            for name, item in value.items():
                if name in properties:
                    self._check(properties[name], item, f'{path}.{name}', errors, document)
                elif schema.get('additionalProperties') is False:
                    errors.append(f'{path}.{name}: not allowed')

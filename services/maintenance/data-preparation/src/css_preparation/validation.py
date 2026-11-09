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
_SUPPORTED = {'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'required',
              'properties', 'additionalProperties', 'maxProperties', 'items', 'maxItems', '$ref'}


class SchemaSubset:
    """Validate values against the named `$defs` of one schema file."""

    def __init__(self, relative_path: str):
        self._DEFS: dict[str, dict[str, Any]] = json.loads((SCHEMAS / relative_path).read_text(encoding='utf-8'))['$defs']

    def errors(self, name: str, value: Any) -> list[str]:
        if name not in self._DEFS:
            raise ValueError(name)
        found: list[str] = []
        self._check(self._DEFS[name], value, '$', found)
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

    def _check(self, schema: dict[str, Any], value: Any, path: str, errors: list[str]) -> None:
        unknown = set(schema) - _SUPPORTED
        if unknown:
            raise RuntimeError(f'Unsupported schema keyword {sorted(unknown)[0]}')
        if '$ref' in schema:
            match = re.fullmatch(r'#/\$defs/([a-z_]+)', schema['$ref'])
            if not match or match.group(1) not in self._DEFS:
                raise RuntimeError(f"Unknown schema reference {schema['$ref']}")
            self._check(self._DEFS[match.group(1)], value, path, errors)
            return
        actual = self._type_of(value)
        if 'type' in schema:
            allowed = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
            if actual not in allowed and not (actual == 'integer' and 'number' in allowed):
                errors.append(f"{path}: expected {' or '.join(allowed)}")
                return
        if 'const' in schema and (value != schema['const'] or self._type_of(value) != self._type_of(schema['const'])):
            errors.append(f"{path}: must be {schema['const']}")
        if 'enum' in schema and value not in schema['enum']:
            errors.append(f'{path}: not an allowed value')
        if isinstance(value, str):
            if 'minLength' in schema and len(value) < schema['minLength']:
                errors.append(f'{path}: too short')
            if 'maxLength' in schema and len(value) > schema['maxLength']:
                errors.append(f'{path}: too long')
            # Schema patterns are anchored; fullmatch also rejects a trailing newline, as JavaScript does.
            if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
                errors.append(f'{path}: invalid format')
        if actual in ('integer', 'number') and 'minimum' in schema and value < schema['minimum']:
            errors.append(f'{path}: below minimum')
        if actual == 'array':
            if 'maxItems' in schema and len(value) > schema['maxItems']:
                errors.append(f'{path}: too many items')
            if 'items' in schema:
                for index, item in enumerate(value):
                    self._check(schema['items'], item, f'{path}[{index}]', errors)
        if actual == 'object':
            properties = schema.get('properties', {})
            if 'maxProperties' in schema and len(value) > schema['maxProperties']:
                errors.append(f'{path}: too many fields')
            for name in schema.get('required', []):
                if name not in value:
                    errors.append(f'{path}.{name}: required')
            for name, item in value.items():
                if name in properties:
                    self._check(properties[name], item, f'{path}.{name}', errors)
                elif schema.get('additionalProperties') is False:
                    errors.append(f'{path}.{name}: not allowed')

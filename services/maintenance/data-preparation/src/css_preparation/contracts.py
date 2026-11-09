"""Executor side of the versioned Maintenance job envelopes.

Validates `schemas/maintenance/jobs.v1.schema.json` with the same small keyword subset
as the Control Worker, rejecting any other keyword. Standard library only.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parents[5] / 'schemas' / 'maintenance' / 'jobs.v1.schema.json'
CONTRACT_VERSION = 'maintenance-job/1'
_SUPPORTED = {'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'required',
              'properties', 'additionalProperties', 'maxProperties', 'items', 'maxItems', '$ref'}
_DEFS: dict[str, dict[str, Any]] = json.loads(SCHEMA_PATH.read_text(encoding='utf-8'))['$defs']


class ContractError(ValueError):
    """A job envelope does not match the versioned contract."""


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


def _check(schema: dict[str, Any], value: Any, path: str, errors: list[str]) -> None:
    unknown = set(schema) - _SUPPORTED
    if unknown:
        raise RuntimeError(f'Unsupported schema keyword {sorted(unknown)[0]}')
    if '$ref' in schema:
        match = re.fullmatch(r'#/\$defs/([a-z_]+)', schema['$ref'])
        if not match or match.group(1) not in _DEFS:
            raise RuntimeError(f"Unknown schema reference {schema['$ref']}")
        _check(_DEFS[match.group(1)], value, path, errors)
        return
    actual = _type_of(value)
    if 'type' in schema:
        allowed = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if actual not in allowed and not (actual == 'integer' and 'number' in allowed):
            errors.append(f"{path}: expected {' or '.join(allowed)}")
            return
    if 'const' in schema and (value != schema['const'] or _type_of(value) != _type_of(schema['const'])):
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
                _check(schema['items'], item, f'{path}[{index}]', errors)
    if actual == 'object':
        properties = schema.get('properties', {})
        if 'maxProperties' in schema and len(value) > schema['maxProperties']:
            errors.append(f'{path}: too many fields')
        for name in schema.get('required', []):
            if name not in value:
                errors.append(f'{path}.{name}: required')
        for name, item in value.items():
            if name in properties:
                _check(properties[name], item, f'{path}.{name}', errors)
            elif schema.get('additionalProperties') is False:
                errors.append(f'{path}.{name}: not allowed')


def contract_errors(name: str, value: Any) -> list[str]:
    """Return the problems with a `job_input` or `job_result` envelope; empty means valid."""
    if name not in ('job_input', 'job_result'):
        raise ValueError(name)
    errors: list[str] = []
    _check(_DEFS[name], value, '$', errors)
    return errors


def parse_job_input(text: str) -> dict[str, Any]:
    """Decode and validate the job input Control dispatched."""
    value = json.loads(text)
    errors = contract_errors('job_input', value)
    if errors:
        raise ContractError('Invalid job input: ' + '; '.join(errors[:5]))
    return value


def job_result(job: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """Build a checkpoint/result envelope that repeats the job's identity and basis."""
    result = {'contract_version': CONTRACT_VERSION, **{key: job[key] for key in
              ('task_id', 'task_revision', 'unit_id', 'attempt', 'basis_digest')}, **fields}
    errors = contract_errors('job_result', result)
    if errors:
        raise ContractError('Invalid job result: ' + '; '.join(errors[:5]))
    return result

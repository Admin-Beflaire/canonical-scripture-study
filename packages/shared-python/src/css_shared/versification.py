"""Lookup of explicit in-memory correspondences, without label inference."""

from copy import deepcopy

from .references import assert_reference, serialize_reference

# Match ECMAScript trim for the TypeScript helper's non-empty basis check.
_WHITESPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip(_WHITESPACE))


def mappings_for(reference, mappings):
    key = serialize_reference(reference)
    result = []
    for mapping in mappings:
        if not isinstance(mapping, dict) or not isinstance(mapping.get("to"), list):
            raise ValueError("Invalid versification mapping")
        assert_reference(mapping["from"])
        for target in mapping["to"]:
            assert_reference(target)
        status = mapping.get("status")
        if (
            status not in ("exact", "partial", "disputed", "missing", "unresolved")
            or not _nonempty(mapping.get("basis"))
            or ("gap_reason" in mapping and not _nonempty(mapping["gap_reason"]))
            or (status == "missing" and mapping["to"])
            or (status in ("exact", "partial", "disputed") and not mapping["to"])
            or (not mapping["to"] and not mapping.get("gap_reason"))
        ):
            raise ValueError("Invalid versification mapping")
        if serialize_reference(mapping["from"]) == key:
            result.append(deepcopy(mapping))
    return result

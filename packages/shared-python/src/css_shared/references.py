"""Native reference helpers consuming the repository's declarative schema."""

import json
import math
from pathlib import Path

SCHEMA = json.loads(
    (Path(__file__).resolve().parents[4] / "schemas/native-reference.v1.schema.json")
    .read_text(encoding="utf-8")
)


def _identifier(value):
    return isinstance(value, str) and len(value) > 0


def _safe_integer(value):
    # JSON Schema integers include 1.0, but never JSON booleans.
    return (
        type(value) in (int, float)
        and abs(value) <= SCHEMA["properties"]["segments"]["items"]["properties"]["start"]["maximum"]
        and math.isfinite(value)
        and value == int(value)
    )


def assert_reference(value):
    """Check shape and endpoint order, not availability or source equivalence."""
    declaration = SCHEMA["properties"]["segments"]
    if (
        not isinstance(value, dict)
        or set(value) != set(SCHEMA["required"])
        or value["schema_version"] != SCHEMA["properties"]["schema_version"]["const"]
        or not _identifier(value["source_revision_id"])
        or not _identifier(value["coordinate_version"])
        or not isinstance(value["segments"], list)
        or len(value["segments"]) < declaration["minItems"]
    ):
        raise ValueError("Invalid native reference")
    for segment in value["segments"]:
        if (
            not isinstance(segment, dict)
            or set(segment) != set(declaration["items"]["required"])
            or not _identifier(segment["unit_id"])
            or not _safe_integer(segment["start"])
            or not _safe_integer(segment["end"])
            or segment["start"] < declaration["items"]["properties"]["start"]["minimum"]
            or segment["end"] < segment["start"]
        ):
            raise ValueError("Invalid native reference")


def _reject_constant(_value):
    raise ValueError("Invalid JSON constant")


def parse_reference(serialized):
    value = json.loads(serialized, parse_constant=_reject_constant)
    assert_reference(value)
    return value


def serialize_reference(reference):
    """Stable identity encoding, with strings and segment order preserved."""
    assert_reference(reference)
    value = {
        "schema_version": reference["schema_version"],
        "source_revision_id": reference["source_revision_id"],
        "coordinate_version": reference["coordinate_version"],
        "segments": [
            {"unit_id": s["unit_id"], "start": int(s["start"]), "end": int(s["end"])}
            for s in reference["segments"]
        ],
    }
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def extract_scalar_segments(reference, text_basis):
    """Only for text supplied in the identified Unicode-scalar profile."""
    assert_reference(reference)
    if (
        reference["source_revision_id"] != text_basis["source_revision_id"]
        or reference["coordinate_version"] != text_basis["coordinate_version"]
    ):
        raise ValueError("Text coordinate basis mismatch")
    result = []
    for segment in reference["segments"]:
        text = text_basis["units"].get(segment["unit_id"])
        if not isinstance(text, str) or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError("Native scalar text unavailable")
        if segment["end"] > len(text):
            raise ValueError("Native coordinate out of bounds")
        result.append(text[int(segment["start"]):int(segment["end"])])
    return result

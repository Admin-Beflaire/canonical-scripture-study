"""Private content-addressed records (quality receipts) outside release data."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Any, Callable

from ..prepare.records import RecordError

_REF_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")


@dataclass(frozen=True)
class RecordStore:
    """Save registers an immutable artifact; load returns its exact saved bytes."""

    save: Callable[[bytes], dict[str, Any]]
    load: Callable[[dict[str, Any]], bytes]


def check_record_ref(reference: Any, data: bytes) -> None:
    """The saved bytes are exactly the artifact the reference names."""
    if (
        not isinstance(data, bytes)
        or not isinstance(reference, dict)
        or set(reference) != {"artifact_id", "sha256", "byte_count"}
        or not isinstance(reference["artifact_id"], str)
        or not _REF_ID.fullmatch(reference["artifact_id"])
        or reference["sha256"] != hashlib.sha256(data).hexdigest()
        or type(reference["byte_count"]) is not int
        or reference["byte_count"] != len(data)
    ):
        raise RecordError("Record artifact identity or bytes do not match")

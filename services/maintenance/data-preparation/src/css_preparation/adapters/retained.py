"""Read an acquired source: its retained original and its registered identity."""

from __future__ import annotations

import hashlib
from typing import Any

from ..prepare.evidence import SourceIdentity, SourceLevel
from ..prepare.records import RecordError


def retained_original(storage: Any, revision: str) -> bytes:
    """The stored bytes of a registered source revision, verified against its registration."""
    node = storage.read_row("source_node", revision)
    if not node or node.get("kind") != "source_revision":
        raise RecordError("Acquired source revision is not registered")
    details = node.get("details_json", {})
    if not isinstance(details, dict) or not all(
        k in details for k in ("locator", "sha256", "byte_count")
    ):
        raise RecordError("Acquired source has no verified locator")
    data = storage.read_blob(details["locator"])
    if (
        len(data) != details["byte_count"]
        or hashlib.sha256(data).hexdigest() != details["sha256"]
    ):
        raise RecordError("Acquired original does not match its registration")
    return data


def retained_identity(storage: Any, revision: str) -> SourceIdentity:
    """The revision's work, edition, representation and revision as registered."""
    nodes = []
    current = revision
    for kind in ("source_revision", "representation", "edition", "work"):
        node = storage.read_row("source_node", current)
        if not node or node.get("kind") != kind:
            raise RecordError("Acquired source ancestry is incomplete")
        nodes.append(node)
        current = node["parent_id"]
    if current is not None:
        raise RecordError("Acquired source ancestry has an unexpected parent")
    levels = [
        SourceLevel(row["id"], row["name"], row["details_json"])
        for row in reversed(nodes)
    ]
    return SourceIdentity(*levels, nodes[0]["attribution"], nodes[0]["origin"])

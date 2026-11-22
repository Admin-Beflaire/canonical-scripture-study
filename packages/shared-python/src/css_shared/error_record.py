"""One safe error record, built where an error is caught.

The record says what failed and where, and nothing else: no secrets, no state bytes, no
source text. That is decided here, once, from the error's class and our own fields; it is
never recovered afterwards by filtering text.

- Only an error of a class marked `OwnMessage` has its message stored. Such a message is
  written by our code from fixed words and identifiers (source, unit, position, field).
  A message from a library, a provider or a command is never stored: the record keeps the
  class name and our own context instead.
- Identifiers and counts are accepted only in a plain shape; anything else is left out.

The record is plain JSON text of at most `MAX_TEXT` characters, so it fits a job result
diagnostic, a GitHub `::error` annotation and a log line alike.
"""

from __future__ import annotations

import json
import re
import sysconfig
import traceback
from pathlib import Path
from typing import Any, Mapping, Sequence

RECORD_VERSION = 1
MAX_TEXT = 1000
MAX_MESSAGE = 200
MAX_FRAMES = 4
MAX_VALUES = 8
OUTCOMES = ("failed", "cancelled", "blocked", "uncertain", "changes")

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
_VALUE = re.compile(r"[A-Za-z0-9._:/@#+=-]{1,80}\Z")
_FOREIGN = tuple(
    {
        str(Path(sysconfig.get_paths()[key]).resolve())
        for key in ("stdlib", "platstdlib", "purelib", "platlib")
    }
)


class OwnMessage:
    """Marks an error whose message our code wrote from fixed words and identifiers.

    Never put source text, a response body or a secret in the message of such an error.
    """


def _frames(error: BaseException) -> list[dict[str, Any]]:
    ours = [
        frame
        for frame in traceback.extract_tb(error.__traceback__)
        if not str(Path(frame.filename).resolve()).startswith(_FOREIGN)
    ]
    return [
        {
            "file": "/".join(Path(frame.filename).parts[-2:]),
            "line": frame.lineno,
            "function": frame.name,
        }
        for frame in ours[-MAX_FRAMES:]
    ]


def _message(error: BaseException) -> str | None:
    if not isinstance(error, OwnMessage):
        return None
    text = "".join(c if c.isprintable() else " " for c in str(error))
    return " ".join(text.split())[:MAX_MESSAGE] or None


def _mapping(values: Mapping[str, Any] | None, *, numbers: bool) -> dict[str, Any]:
    kept: dict[str, Any] = {}
    for key, value in (values or {}).items():
        if not (isinstance(key, str) and _CODE.match(key)):
            continue
        if type(value) is int and 0 <= value < 10**12:
            kept[key] = value
        elif not numbers and isinstance(value, str) and _VALUE.match(value):
            kept[key] = value
    return dict(sorted(kept.items())[:MAX_VALUES])


def error_record(
    error: BaseException | None,
    *,
    tool: str,
    stage: str,
    code: str,
    outcome: str = "failed",
    ids: Mapping[str, Any] | None = None,
    counts: Mapping[str, int] | None = None,
    names: Sequence[str] | None = None,
    exit_code: int | None = None,
    http_status: int | None = None,
    provider_code: str | int | None = None,
) -> dict[str, Any]:
    """The safe record of `error`, or of a condition that has no error.

    `tool` is the workflow or tool, `stage` the step it was in."""
    if not (
        _NAME.match(tool)
        and _NAME.match(stage)
        and _CODE.match(code)
        and outcome in OUTCOMES
    ):
        raise ValueError("Error record needs a plain tool, stage, code and outcome")
    record: dict[str, Any] = {
        "v": RECORD_VERSION,
        "tool": tool,
        "stage": stage,
        "outcome": outcome,
        "code": code,
    }
    if error is not None:
        name = type(error).__name__
        record["error"] = name if _NAME.match(name) else "Error"
    if http_status is None:
        http_status = getattr(error, "status", None)
    if type(http_status) is int and 100 <= http_status <= 599:
        record["http"] = http_status
    if type(provider_code) is int or (
        isinstance(provider_code, str) and _VALUE.match(provider_code)
    ):
        record["provider_code"] = provider_code
    if type(exit_code) is int and 0 <= exit_code <= 255:
        record["exit"] = exit_code
    if identifiers := _mapping(ids, numbers=False):
        record["ids"] = identifiers
    if key_counts := _mapping(counts, numbers=True):
        record["counts"] = key_counts
    if plain_names := [
        n for n in (names or ()) if isinstance(n, str) and _CODE.match(n)
    ][:MAX_VALUES]:
        record["names"] = sorted(plain_names)
    if error is not None and (frames := _frames(error)):
        record["at"] = frames
    if error is not None and (message := _message(error)):
        record["message"] = message
    return record


def record_text(record: Mapping[str, Any]) -> str:
    """The record as compact JSON of at most `MAX_TEXT` characters.

    If it is too long, parts give way in this order: older code locations, the message,
    the counts, the identifiers. The fixed fields always stay.
    """
    shrunk = dict(record)
    steps = [
        lambda r: r.update(at=r["at"][-1:]) if len(r.get("at", ())) > 1 else None,
        lambda r: r.pop("at", None),
        lambda r: r.pop("message", None),
        lambda r: r.pop("counts", None),
        lambda r: r.pop("names", None),
        lambda r: r.pop("ids", None),
    ]
    for step in [None, *steps]:
        if step is not None:
            step(shrunk)
        text = json.dumps(
            shrunk, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        if len(text) <= MAX_TEXT:
            return text
    raise ValueError("Error record does not fit its limit")


def annotation(record: Mapping[str, Any], level: str = "error") -> str:
    """A GitHub workflow command for the record: `error` (the default), `warning` or `notice`.

    One line, with the command characters escaped."""
    text = (
        record_text(record)
        .replace("%", "%25")
        .replace("\r", "%0D")
        .replace("\n", "%0A")
    )
    if level not in ("error", "warning", "notice"):
        raise ValueError("Annotation level is error, warning or notice")
    return f"::{level} title={record['tool']} {record['stage']}::{text}"

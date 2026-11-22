"""Safe records for Terraform, Wrangler and other command output.

A command's own output stays in a private file on the runner. This module reads
that file and prints only error records (see `error_record`): a fixed message for
the kind of failure, the resource address, the planned action for each resource and
the names of the attributes that would change. The tool's own wording is read only
to choose that fixed message and is never printed. It never keeps values, detail
blocks, plan output or state.

Run as `python3 -m css_shared.tool_log <terraform|wrangler|none> --tool T --stage S
[--exit N] [--log FILE] [--id key=value ...]`. It always exits 0, so it never hides
the step's own result.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Mapping, Sequence

from .error_record import OwnMessage, annotation, error_record

MAX_FAILURES = 3
MAX_RESOURCES = 8

_BOX = " \t│╷╵"
_ADDRESS = re.compile(
    r"((?:module\.[A-Za-z0-9_-]+\.)*[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+)(?:\[.*)?\Z"
)
_TERRAFORM_ERROR = re.compile(r"Error: (.+)\Z")
_TERRAFORM_WITH = re.compile(r"with (.+?),?\Z")
_WRANGLER_ERROR = re.compile(r"(?:✘|X) \[ERROR\] (.+)\Z")
_PROVIDER_CODE = re.compile(r"\[code: (\d+)\]")
_PLAN_TOTALS = re.compile(r"Plan: (\d+) to add, (\d+) to change, (\d+) to destroy")
_PLAN_HEADER = re.compile(r" {2}# (\S+) (.*)\Z")
_ATTRIBUTE = re.compile(r"(?:[~+-]|-/\+|\+/-) +([a-z][a-z0-9_]*) *(?:=|\{)")
_HEREDOC = re.compile(r"<<-?([A-Za-z_][A-Za-z0-9_]*) *\Z")
_ACTIONS = (
    ("will be created", "create"),
    ("will be updated in-place", "update"),
    ("will be destroyed", "destroy"),
    ("must be replaced", "replace"),
    ("will be replaced", "replace"),
    ("will be read during apply", "read"),
)
# The tool's summary line may hold a value, a short credential or private data, so
# it is only matched against these kinds. The record carries the fixed message of the
# first kind that matches; a summary of no known kind gives no message.
_KINDS = (
    *(
        (
            re.compile(rf"(?:failed to|error) {verb}", re.IGNORECASE),
            f"The provider could not {verb} a resource.",
        )
        for verb in ("create", "update", "delete", "read")
    ),
    (re.compile(r"state lock", re.IGNORECASE), "The state lock could not be acquired."),
    (
        re.compile(
            r"unauthori[sz]ed|forbidden|authentication|permission|api token",
            re.IGNORECASE,
        ),
        "The provider refused the credentials or the permission.",
    ),
    (
        re.compile(r"already exists|conflict", re.IGNORECASE),
        "A resource already exists or conflicts.",
    ),
    (
        re.compile(r"not found|does not exist|could not find", re.IGNORECASE),
        "A resource or file was not found.",
    ),
    (re.compile(r"time ?out|timed out", re.IGNORECASE), "The request timed out."),
    (
        re.compile(r"rate limit|too many requests", re.IGNORECASE),
        "The provider rate limit was reached.",
    ),
    (
        re.compile(r"could not resolve|cannot find module", re.IGNORECASE),
        "A module could not be resolved.",
    ),
    (
        re.compile(r"unexpected|syntax", re.IGNORECASE),
        "A source file has a syntax error.",
    ),
    (
        re.compile(r"invalid|unsupported|required|missing", re.IGNORECASE),
        "A value or setting was rejected.",
    ),
)


class ToolSummaryError(OwnMessage, Exception):
    """A fixed message for the kind of failure a tool reported (never its own text)."""


_COLOUR = re.compile(r"\x1b\[[0-9;]*m")


def _plain(text: str) -> str:
    """The tool's output without colour codes (some tools colour output sent to a file)."""
    return _COLOUR.sub("", text)


def _kind(summary: str) -> str | None:
    """The fixed message for the kind of failure a tool summary describes, if known."""
    return next(
        (message for pattern, message in _KINDS if pattern.search(summary)), None
    )


def _address(token: str) -> str | None:
    match = _ADDRESS.match(token.strip())
    return match[1] if match else None


def _terraform_failures(text: str) -> list[dict]:
    """Each `Error:` summary with the resource address printed under it."""
    found: list[dict] = []
    lines_left = 0
    for raw in text.splitlines():
        line = raw.strip(_BOX)
        if error := _TERRAFORM_ERROR.match(line):
            found.append({"summary": error[1], "address": None})
            lines_left = 6
        elif found and lines_left:
            lines_left -= 1
            if (with_line := _TERRAFORM_WITH.match(line)) and not found[-1]["address"]:
                found[-1]["address"] = _address(with_line[1])
    return found


def _wrangler_failures(text: str) -> list[dict]:
    """Each `[ERROR]` line (Wrangler and esbuild) with a provider code under it."""
    found: list[dict] = []
    lines_left = 0
    for raw in text.splitlines():
        line = raw.strip()
        if error := _WRANGLER_ERROR.match(line):
            found.append({"summary": error[1], "address": None, "provider_code": None})
            lines_left = 6
        elif found and lines_left:
            lines_left -= 1
            if found[-1]["provider_code"] is None and (
                code := _PROVIDER_CODE.search(line)
            ):
                found[-1]["provider_code"] = int(code[1])
    return found


_FAILURES = {"terraform": _terraform_failures, "wrangler": _wrangler_failures}


def plan_changes(text: str) -> tuple[tuple[int, int, int] | None, list[dict]]:
    """The plan totals and, for each resource, its action and changed attribute names."""
    totals = None
    resources: list[dict] = []
    current = None
    heredoc_end = None
    for raw in text.splitlines():
        line = raw.strip()
        if heredoc_end is not None:
            if line.split(" ", 1)[0] == heredoc_end:
                heredoc_end = None
            continue
        if totals_match := _PLAN_TOTALS.search(line):
            totals = tuple(int(n) for n in totals_match.groups())
            current = None
        elif header := _PLAN_HEADER.match(raw):
            address = _address(header[1])
            action = next((a for words, a in _ACTIONS if words in header[2]), None)
            current = None
            if address and action:
                current = {"resource": address, "action": action, "names": []}
                resources.append(current)
        elif current is not None and (attribute := _ATTRIBUTE.match(line)):
            if attribute[1] not in current["names"]:
                current["names"].append(attribute[1])
        if heredoc := _HEREDOC.search(line):
            heredoc_end = heredoc[1]
    return totals, resources


def failure_records(
    parser: str,
    text: str,
    *,
    tool: str,
    stage: str,
    exit_code: int | None = None,
    ids: Mapping[str, str] | None = None,
) -> list[dict]:
    """Error records for a failed command: one for each `Error:`/`[ERROR]` summary."""
    code = "command_failed" if parser == "none" else f"{parser}_failed"
    failures = _FAILURES.get(parser, lambda _: [])(_plain(text))[:MAX_FAILURES]
    if not failures:
        return [
            error_record(
                None, tool=tool, stage=stage, code=code, ids=ids, exit_code=exit_code
            )
        ]
    records = []
    for failure in failures:
        summary = _kind(failure["summary"])
        fields = {
            **(ids or {}),
            **({"resource": failure["address"]} if failure["address"] else {}),
        }
        records.append(
            error_record(
                ToolSummaryError(summary) if summary else None,
                tool=tool,
                stage=stage,
                code=code,
                ids=fields,
                exit_code=exit_code,
                provider_code=failure.get("provider_code"),
            )
        )
    return records


def plan_records(
    text: str, *, tool: str, stage: str, ids: Mapping[str, str] | None = None
) -> list[dict]:
    """Records for a plan that is not clean: the totals, then each resource's action."""
    totals, resources = plan_changes(_plain(text))
    if not totals and not resources:
        return []
    counts = {"resources": len(resources)}
    if totals:
        counts.update(add=totals[0], change=totals[1], destroy=totals[2])
    records = [
        error_record(
            None,
            tool=tool,
            stage=stage,
            code="plan_changes",
            outcome="changes",
            ids=ids,
            counts=counts,
        )
    ]
    for resource in resources[:MAX_RESOURCES]:
        records.append(
            error_record(
                None,
                tool=tool,
                stage=stage,
                code="plan_resource",
                outcome="changes",
                ids={
                    **(ids or {}),
                    "resource": resource["resource"],
                    "action": resource["action"],
                },
                counts={"attributes": len(resource["names"])},
                names=resource["names"],
            )
        )
    return records


def _read(path: str | None) -> str:
    try:
        return Path(path).read_text(errors="replace") if path else ""
    except OSError:
        return ""


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parser", choices=("terraform", "wrangler", "none"))
    parser.add_argument("--tool", required=True)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--exit", type=int, default=0, dest="exit_code")
    parser.add_argument("--log")
    parser.add_argument("--id", action="append", default=[], dest="ids")
    args = parser.parse_args(argv)
    ids = dict(item.split("=", 1) for item in args.ids if "=" in item)
    try:
        text = _read(args.log)
        if args.exit_code:
            records = failure_records(
                args.parser,
                text,
                tool=args.tool,
                stage=args.stage,
                exit_code=args.exit_code,
                ids=ids,
            )
            level = "error"
        elif args.parser == "terraform":
            records = plan_records(text, tool=args.tool, stage=args.stage, ids=ids)
            level = "notice"
        else:
            records, level = [], "notice"
        for record in records:
            print(annotation(record, level))
    except Exception as error:  # The summary must never hide the step's own result.
        print(
            annotation(
                error_record(
                    error, tool="tool_log", stage="summary", code="summary_failed"
                )
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

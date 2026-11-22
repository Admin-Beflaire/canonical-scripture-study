"""The failure diagnostic of a job result: one safe error record (see `css_shared.error_record`)."""

from __future__ import annotations

from typing import Any, Mapping

from css_shared.error_record import error_record, record_text


def job_ids(job: Mapping[str, Any]) -> dict[str, Any]:
    """The job identifiers a record carries."""
    return {"unit": job["unit_id"], "attempt": job["attempt"], "task": job["task_id"]}


def diagnostic(
    job: Mapping[str, Any],
    stage: str,
    code: str,
    error: BaseException | None = None,
    **fields: Any,
) -> dict[str, str]:
    """A job result diagnostic: our `code` and the record of what failed, in which tool and stage."""
    record = error_record(
        error, tool=job["kind"], stage=stage, code=code, ids=job_ids(job), **fields
    )
    return {"code": code, "message": record_text(record)}

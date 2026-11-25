"""Fetch one declared acquisition route into memory."""

from __future__ import annotations

from pathlib import Path
import tempfile

from ..executor.unit import RetryableUnitError
from ..prepare.records import RecordError
from .transfer import Route, TransferError, TransferResult, transfer


def fetch_original(route: Route) -> tuple[bytes, TransferResult]:
    """The route's bytes with the transfer receipt; an interrupted transfer is retryable."""
    with tempfile.TemporaryDirectory() as directory:
        try:
            result = transfer(route, Path(directory) / "original")
        except TransferError as error:
            raise RecordError(f"Acquisition failed: {error}") from None
        if not result.complete:
            raise RetryableUnitError("Transfer interrupted")
        return result.path.read_bytes(), result

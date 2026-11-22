"""Provider failures without response bodies or credentials in diagnostics."""


class ProviderError(Exception):
    def __init__(
        self, message: str, *, status: int | None = None, transient: bool = False
    ):
        super().__init__(message)
        self.status = status
        self.transient = transient


def provider_diagnostic(error: ProviderError, stage: str | None = None) -> str:
    status = (
        error.status
        if type(error.status) is int and 100 <= error.status <= 599
        else None
    )
    where = f" during {stage}" if stage else ""
    return (
        f"Provider request failed{where} with HTTP {status}"
        if status
        else f"Provider request failed{where}; HTTP status unavailable"
    )


def stage_diagnostic(stage: str, *, transient: bool = False) -> str:
    return (
        f"Transient failure during {stage}; retries exhausted"
        if transient
        else f"Failure during {stage}; detail unavailable"
    )


def quality_diagnostic(stage: str) -> str:
    return f"Quality failure during {stage}; detail unavailable"

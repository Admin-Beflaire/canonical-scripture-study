"""Provider failures. The message is ours and never holds a response body or a credential."""

from css_shared.error_record import OwnMessage


class ProviderError(OwnMessage, Exception):
    def __init__(
        self, message: str, *, status: int | None = None, transient: bool = False
    ):
        super().__init__(message)
        self.status = status
        self.transient = transient

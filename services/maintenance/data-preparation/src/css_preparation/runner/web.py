"""Small HTTPS client shared by the runner adapters.

Credentials travel only in request headers to the configured origin. Redirects are
refused, so a header is never forwarded to another destination. Error text never
includes response bodies or header values.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


class ProviderError(Exception):
    """A provider or Control call failed; the message contains no secret or body text."""

    def __init__(self, message: str, *, status: int | None = None, transient: bool = False):
        super().__init__(message)
        self.status = status
        self.transient = transient


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise ProviderError('Redirect refused', status=code)


_OPENER = urllib.request.build_opener(_NoRedirect)


@dataclass(frozen=True)
class Origin:
    """One HTTPS origin. Plain HTTP is accepted only for a loopback test server."""

    base: str
    timeout: float = 60.0

    def __post_init__(self) -> None:
        parts = urllib.parse.urlsplit(self.base)
        loopback = parts.scheme == 'http' and parts.hostname in ('127.0.0.1', 'localhost')
        if ((parts.scheme != 'https' and not loopback) or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment or self.base.endswith('/')):
            raise ValueError('Origin must be an HTTPS origin without credentials, query or trailing slash')

    def request(self, method: str, path: str, headers: dict[str, str], body: bytes | None = None,
                *, allow_missing: bool = False) -> bytes | None:
        if not path.startswith('/'):
            raise ValueError('Request path must be absolute')
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with _OPENER.open(request, timeout=self.timeout) as response:
                return response.read()
        except ProviderError:
            raise
        except urllib.error.HTTPError as error:
            error.close()
            if allow_missing and error.code == 404:
                return None
            raise ProviderError(f'{method} request refused with HTTP {error.code}', status=error.code,
                                transient=error.code == 429 or error.code >= 500) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            raise ProviderError(f'{method} request did not complete', transient=True) from None

    def json(self, method: str, path: str, headers: dict[str, str], value: Any) -> Any:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        data = self.request(method, path, {**headers, 'Content-Type': 'application/json'}, body)
        try:
            return json.loads(data or b'null')
        except (UnicodeError, ValueError):
            raise ProviderError(f'{method} response was not JSON') from None

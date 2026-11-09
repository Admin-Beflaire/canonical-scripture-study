"""Bounded transfer of one declared acquisition route.

Redirects stay on the route's declared hosts and never carry the credential. A resumed
transfer continues only with the same upstream basis (ETag or Last-Modified); a changed
basis discards the partial bytes and starts a distinct input. Errors never include
headers or credential values.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import http.client
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

CHUNK = 1 << 16


class TransferError(RuntimeError):
    """The transfer left its route, exceeded its bounds or did not match its expected bytes."""


@dataclass(frozen=True)
class Route:
    id: str
    url: str
    allowed_hosts: frozenset[str]
    max_bytes: int
    expected_sha256: str | None = None
    require_https: bool = True


@dataclass(frozen=True)
class TransferResult:
    path: Path
    byte_count: int
    sha256: str
    upstream_basis: str
    complete: bool
    resumed: bool
    new_basis: bool


def _check_url(route: Route, url: str) -> None:
    parts = urllib.parse.urlsplit(url)
    if route.require_https and parts.scheme != 'https':
        raise TransferError(f'{route.id}: only HTTPS is allowed')
    if parts.scheme not in ('https', 'http') or parts.username or parts.password or parts.hostname not in route.allowed_hosts:
        raise TransferError(f'{route.id}: destination is outside the declared route')


class _ConfinedRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, route: Route):
        self.route = route

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(self.route, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def transfer(route: Route, destination: Path, *, credential: tuple[str, str] | None = None, timeout: float = 60) -> TransferResult:
    """Download the route into `destination`, resuming a matching partial file."""
    if route.max_bytes < 1:
        raise TransferError(f'{route.id}: a byte limit is required')
    _check_url(route, route.url)
    destination = Path(destination)
    partial, state = destination.with_name(destination.name + '.part'), destination.with_name(destination.name + '.basis')
    saved = None
    if state.exists() and partial.exists():
        try:
            saved = json.loads(state.read_text())
            # A partial file from another URL is never continued, even with an equal ETag.
            if not isinstance(saved, dict) or not isinstance(saved.get('basis'), str) or saved.get('url') != route.url:
                saved = None
        except (OSError, ValueError):
            saved = None  # unusable state: start again from zero
    offset = partial.stat().st_size if saved else 0

    request = urllib.request.Request(route.url, headers={'Accept-Encoding': 'identity'})
    if credential:
        # Unredirected: urllib never copies it to a redirect target.
        request.add_unredirected_header(*credential)
    if saved and offset and saved.get('basis', '').startswith(('etag:', 'modified:')):
        request.add_header('Range', f'bytes={offset}-')
        request.add_header('If-Range', saved['basis'].split(':', 1)[1])
    opener = urllib.request.build_opener(_ConfinedRedirect(route))
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        raise TransferError(f'{route.id}: server answered {error.code}') from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, TransferError):
            raise error.reason from None
        raise TransferError(f'{route.id}: transfer failed') from None
    with response:
        _check_url(route, response.geturl())
        etag, modified = response.headers.get('ETag'), response.headers.get('Last-Modified')
        basis = f'etag:{etag}' if etag else f'modified:{modified}' if modified else 'unversioned'
        resumed = response.status == 206 and saved is not None and saved['basis'] == basis
        new_basis = saved is not None and saved['basis'] != basis
        if response.status == 206 and not resumed:
            raise TransferError(f'{route.id}: partial answer without a matching basis')
        total = None
        if response.status == 206:
            span = response.headers.get('Content-Range', '')
            if not span.startswith(f'bytes {offset}-'):
                raise TransferError(f'{route.id}: resumed at the wrong offset')
            total = int(span.rsplit('/', 1)[1]) if span.rsplit('/', 1)[1].isdigit() else None
        elif response.headers.get('Content-Length', '').isdigit():
            total = int(response.headers['Content-Length'])
        if total is not None and total > route.max_bytes:
            raise TransferError(f'{route.id}: larger than the declared limit')
        if not resumed:
            offset = 0
        state.write_text(json.dumps({'basis': basis, 'url': route.url}))
        size, interrupted = offset, False
        with partial.open('ab' if resumed else 'wb') as handle:
            while True:
                try:
                    chunk = response.read(CHUNK)
                except (http.client.IncompleteRead, OSError):
                    interrupted = True  # keep the partial bytes; a later run resumes with the same basis
                    break
                if not chunk:
                    break
                size += len(chunk)
                if size > route.max_bytes:
                    handle.close()
                    partial.unlink(missing_ok=True)
                    state.unlink(missing_ok=True)
                    raise TransferError(f'{route.id}: larger than the declared limit')
                handle.write(chunk)
    complete = not interrupted and (total is None or size == total)
    digest = hashlib.sha256()
    with partial.open('rb') as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    if not complete:
        return TransferResult(partial, size, sha256, basis, False, resumed, new_basis)
    if route.expected_sha256 and sha256 != route.expected_sha256:
        partial.unlink(missing_ok=True)
        state.unlink(missing_ok=True)
        raise TransferError(f'{route.id}: bytes differ from the expected revision')
    partial.replace(destination)
    state.unlink(missing_ok=True)
    return TransferResult(destination, size, sha256, basis, True, resumed, new_basis)

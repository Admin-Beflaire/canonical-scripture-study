"""Private R2 objects through R2's S3-compatible API (AWS Signature Version 4, standard library only).

Cloudflare's REST API only accepts account-wide R2 tokens for object operations and is rate
limited to 1,200 R2 requests per five minutes per account; the S3-compatible API accepts a
token scoped to one bucket and is meant for object traffic. Its credentials derive from the
same preparation API token: the access key ID is the token's ID and the secret access key is
the SHA-256 of the token value, so no extra secret is stored.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import re
from typing import Callable
import urllib.parse

from .web import Origin, ProviderError

_UNRESERVED = '-_.~'


def _quote(segment: str) -> str:
    return urllib.parse.quote(segment, safe=_UNRESERVED)


def sign_v4(method: str, host: str, path: str, headers: dict[str, str], payload_hash: str, *,
            access_key: str, secret_key: str, region: str, service: str, now: datetime) -> dict[str, str]:
    """Return headers including `Authorization` for one request (no query string).

    `path` is already URI-encoded; `headers` are the extra headers to sign (lower-case names).
    """
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    day = stamp[:8]
    signed = {'host': host, 'x-amz-date': stamp, **{k.lower(): v.strip() for k, v in headers.items()}}
    names = sorted(signed)
    canonical = '\n'.join([method, path, '', ''.join(f'{n}:{signed[n]}\n' for n in names), ';'.join(names), payload_hash])
    scope = f'{day}/{region}/{service}/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode('utf-8')).hexdigest()])
    key = f'AWS4{secret_key}'.encode('utf-8')
    for part in (day, region, service, 'aws4_request'):
        key = hmac.new(key, part.encode('utf-8'), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode('utf-8'), hashlib.sha256).hexdigest()
    return {**{k: v for k, v in signed.items() if k != 'host'},
            'Authorization': f'AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={";".join(names)}, Signature={signature}'}


@dataclass(frozen=True)
class R2Objects:
    """One bucket through the S3-compatible endpoint `https://<account>.r2.cloudflarestorage.com`."""

    account_id: str
    bucket: str
    access_key_id: str
    token: str
    origin: Origin | None = None
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def __post_init__(self) -> None:
        if not re.fullmatch(r'[0-9a-f]{32}', self.access_key_id):
            raise ValueError('R2 access key ID must be the preparation token ID')

    @property
    def _origin(self) -> Origin:
        return self.origin or Origin(f'https://{self.account_id}.r2.cloudflarestorage.com')

    def _request(self, method: str, key: str, body: bytes | None = None, extra: dict[str, str] | None = None,
                 *, allow: tuple[int, ...] = ()) -> bytes | None | int:
        path = f'/{_quote(self.bucket)}/' + '/'.join(_quote(part) for part in key.split('/'))
        payload = hashlib.sha256(body or b'').hexdigest()
        host = urllib.parse.urlsplit(self._origin.base).netloc
        headers = sign_v4(method, host, path, {'x-amz-content-sha256': payload, **(extra or {})}, payload,
                          access_key=self.access_key_id, secret_key=hashlib.sha256(self.token.encode('utf-8')).hexdigest(),
                          region='auto', service='s3', now=self.clock())
        try:
            return self._origin.request(method, path, headers, body)
        except ProviderError as error:
            if error.status in allow:
                return error.status
            raise

    def get(self, key: str) -> bytes | None:
        """The object's bytes, or None when the key does not exist."""
        data = self._request('GET', key, allow=(404,))
        return None if data == 404 else data  # type: ignore[return-value]

    def create(self, key: str, data: bytes) -> bool:
        """Write only if the key is absent (atomic `If-None-Match: *`). False when it already exists."""
        status = self._request('PUT', key, data, {'if-none-match': '*', 'content-type': 'application/octet-stream'},
                               allow=(412,))
        return status != 412

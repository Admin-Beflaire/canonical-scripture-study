"""Local stand-ins for the Cloudflare REST API and Control's internal job routes.

Synthetic only: a loopback HTTP server backed by in-memory SQLite (with the real
migrations) and a dictionary of objects. No real provider is contacted.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import sqlite3
import threading
import urllib.parse

from css_preparation.prepare.records import migrations
from css_preparation.runner.cloudflare import CloudflareConfig, CloudflareStorage
from css_preparation.runner.control import ControlClient, ControlConfig
from css_preparation.runner.r2 import sign_v4
from css_preparation.runner.web import Origin
from css_preparation.runner import __main__ as runner

TOKEN_ID = "0123456789abcdef0123456789abcdef"
WIRE = json.loads(
    (
        Path(__file__).resolve().parents[1] / "conformance/dp04-control-wire.v1.json"
    ).read_text(encoding="utf-8")
)


def storage_for(api, token="synthetic-token"):
    """Cloudflare storage that talks to the loopback API."""
    return CloudflareStorage(
        CloudflareConfig(
            "acct",
            "db",
            "bucket",
            token,
            TOKEN_ID,
            api=Origin(api.origin),
            r2_origin=Origin(api.origin),
        )
    )


def control_client_for(api):
    """Control client that talks to the loopback API without waiting between retries."""
    return ControlClient(
        ControlConfig(Origin(api.origin), "synthetic-id", "synthetic-secret"),
        sleep=lambda _: None,
    )


def dispatched_control(current, run_id):
    """Control double for whole runs: every state read reports the job text `current()`
    as dispatched to this run, and every submitted result is accepted."""

    def control(method, path, headers, body):
        if path != "/internal/jobs/state":
            return 200, {"status": "accepted", "eligible": True, "state": "succeeded"}
        text = current()
        job = json.loads(text)
        return 200, {
            "task_id": job["task_id"],
            "task_revision": job["task_revision"],
            "task_state": "running",
            "task_basis_digest": job["basis_digest"],
            "unit_id": job["unit_id"],
            "attempt": job["attempt"],
            "job_revision": job["task_revision"],
            "job_input_basis": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "run_id": run_id,
            "job_state": "dispatched",
        }

    return control


def run_recipe_unit(case, recipe, unit_id, run_id, **changes):
    """Run one unit of a recipe file as Control would dispatch it, with the test case's
    inputs, storage and Control client; the job text is kept on `case.current`."""
    unit = next(item for item in recipe["units"] if item["unit_id"] == unit_id)
    job = deepcopy(WIRE["job_input"])
    job.update(
        unit_id=unit_id,
        kind=unit["kind"],
        native_extent=unit["native_extent"],
        recipe_revision=recipe["revision"],
        input_refs=case.inputs,
        dependency_refs=[],
        required_capabilities=unit.get("required_capabilities", []),
        constraints={},
    )
    job.update(changes)
    case.current = json.dumps(
        job, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return runner.run_job(
        case.current,
        unit["kind"],
        run_id=run_id,
        control=case.client,
        storage=case.storage,
    )


class _Handler(BaseHTTPRequestHandler):
    server: "LoopbackApi"

    def log_message(self, *args):  # keep test output quiet
        pass

    def _send(self, status, body=b"", content="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))

    def _route(self, method):
        api = self.server
        api.requests.append((method, self.path, dict(self.headers)))
        if api.redirect_once:
            api.redirect_once = False
            return self._send(
                302, headers={"Location": "https://elsewhere.invalid/steal"}
            )
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/internal/jobs/"):
            return api.control(self, method, path, self._body())
        match = re.fullmatch(r"/bucket/(.+)", path)
        if match:
            return self._s3(method, path, urllib.parse.unquote(match[1]))
        if self.headers.get("Authorization") != f"Bearer {api.token}":
            return self._send(403, b'{"success":false}')
        match = re.fullmatch(r"/client/v4/accounts/acct/d1/database/db/query", path)
        if match and method == "POST":
            return self._d1(json.loads(self._body()))
        return self._send(404, b"{}")

    def _s3(self, method, path, key):
        """R2's S3-compatible API: SigV4 with credentials derived from the token; atomic create."""
        api = self.server
        body = self._body() if method == "PUT" else b""
        auth = self.headers.get("Authorization", "")
        match = re.fullmatch(
            r"AWS4-HMAC-SHA256 Credential=(\w+)/\d{8}/auto/s3/aws4_request, "
            r"SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}",
            auth,
        )
        if (
            not match
            or match[1] != TOKEN_ID
            or self.headers.get("x-amz-content-sha256")
            != hashlib.sha256(body).hexdigest()
        ):
            return self._send(
                403, b"<Error><Code>AccessDenied</Code></Error>", "application/xml"
            )
        names = match[2].split(";")
        extra = {
            name: self.headers[name]
            for name in names
            if name not in ("host", "x-amz-date")
        }
        now = datetime.strptime(self.headers["x-amz-date"], "%Y%m%dT%H%M%SZ").replace(
            tzinfo=timezone.utc
        )
        expected = sign_v4(
            method,
            self.headers["Host"],
            path,
            extra,
            hashlib.sha256(body).hexdigest(),
            access_key=TOKEN_ID,
            secret_key=hashlib.sha256(api.token.encode()).hexdigest(),
            region="auto",
            service="s3",
            now=now,
        )["Authorization"]
        if expected != auth:
            return self._send(
                403,
                b"<Error><Code>SignatureDoesNotMatch</Code></Error>",
                "application/xml",
            )
        api.signed_paths.append((method, path))
        if method == "GET":
            if key not in api.objects:
                return self._send(
                    404, b"<Error><Code>NoSuchKey</Code></Error>", "application/xml"
                )
            return self._send(200, api.objects[key], "application/octet-stream")
        if method == "PUT":
            if self.headers.get("If-None-Match") == "*" and key in api.objects:
                return self._send(
                    412,
                    b"<Error><Code>PreconditionFailed</Code></Error>",
                    "application/xml",
                )
            api.objects[key] = body
            return self._send(200, b"")
        return self._send(405, b"")

    def _d1(self, body):
        api = self.server
        statements = body["batch"] if "batch" in body else [body]
        if "batch" in body:
            api.batches.append(len(statements))
        results = []
        try:
            with (
                api.db
            ):  # One transaction for the whole batch, like a D1 binding batch.
                for item in statements:
                    api.queries.append(item["sql"])
                    if len(item.get("params", [])) > 100:  # D1's bound-parameter limit
                        raise ValueError("too many bound parameters")
                    cursor = api.db.execute(item["sql"], item.get("params", []))
                    rows = [dict(row) for row in cursor.fetchall()]
                    results.append({"success": True, "results": rows, "meta": {}})
        except Exception as error:
            api.last_error = repr(error)
            return self._send(
                400,
                json.dumps({"success": False, "errors": [{"message": "x"}]}).encode(),
            )
        return self._send(
            200, json.dumps({"success": True, "result": results}).encode()
        )

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")


class LoopbackApi(HTTPServer):
    def __init__(self, token="synthetic-token"):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.token = token
        # One serving thread uses this connection; requests are handled one at a time.
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for path in migrations():
            self.db.executescript(path.read_text(encoding="utf-8"))
        self.last_error = None
        self.objects: dict[str, bytes] = {}
        self.requests: list = []
        self.batches: list[int] = []
        self.queries: list[str] = []
        self.redirect_once = False
        self.signed_paths: list = []
        self.control_handler = None
        # A short poll lets shutdown return at once; the default waits half a second per test.
        self._thread = threading.Thread(
            target=self.serve_forever, args=(0.01,), daemon=True
        )

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def control(self, handler, method, path, body):
        if self.control_handler is None:
            return handler._send(404, b"{}")
        status, reply = self.control_handler(method, path, dict(handler.headers), body)
        return handler._send(status, json.dumps(reply).encode())

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.shutdown()
        self.server_close()
        # Left open, a later test's captured output can receive the ResourceWarning.
        self.db.close()

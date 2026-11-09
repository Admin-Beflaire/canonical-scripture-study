"""Bounded transfer against a local test server (synthetic bytes)."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest

from css_preparation.acquire.transfer import Route, TransferError, transfer

BODY = b'0123456789' * 100
SEEN = []


class Handler(BaseHTTPRequestHandler):
    etag = '"v1"'

    def log_message(self, *args):
        pass

    def do_GET(self):
        SEEN.append((self.path, self.headers.get('Authorization')))
        if self.path == '/redirect-same':
            return self._redirect(f'http://127.0.0.1:{self.server.server_port}/file')
        if self.path == '/redirect-away':
            return self._redirect(f'http://localhost:{self.server.server_port}/file')
        if self.path == '/redirect-userinfo':
            return self._redirect(f'http://user:pw@127.0.0.1:{self.server.server_port}/file')
        if self.path == '/truncated':
            self.send_response(200)
            self.send_header('Content-Length', str(len(BODY)))
            self.send_header('ETag', Handler.etag)
            self.end_headers()
            self.wfile.write(BODY[:400])
            self.close_connection = True
            return
        if self.path not in ('/file', '/big'):
            self.send_error(404)
            return
        body = BODY * 20 if self.path == '/big' else BODY
        start = 0
        ranged = self.headers.get('Range')
        if ranged and self.headers.get('If-Range') == Handler.etag:
            start = int(ranged.split('=')[1].rstrip('-'))
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{len(body) - 1}/{len(body)}')
        else:
            self.send_response(200)
        self.send_header('ETag', Handler.etag)
        self.send_header('Content-Length', str(len(body) - start))
        self.end_headers()
        self.wfile.write(body[start:])

    def _redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()


class TransferTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.target = Path(self.directory.name) / 'original.bin'
        SEEN.clear()
        Handler.etag = '"v1"'

    def tearDown(self):
        self.directory.cleanup()

    def route(self, path='/file', **overrides):
        values = dict(id='route-a', url=self.base + path, allowed_hosts=frozenset({'127.0.0.1'}), max_bytes=5000, require_https=False)
        values.update(overrides)
        return Route(**values)

    def test_complete_transfer_keeps_exact_bytes(self):
        result = transfer(self.route(expected_sha256=hashlib.sha256(BODY).hexdigest()), self.target)
        self.assertEqual((result.byte_count, result.complete, result.upstream_basis), (1000, True, 'etag:"v1"'))
        self.assertEqual(self.target.read_bytes(), BODY)
        with self.assertRaises(TransferError):
            transfer(self.route(expected_sha256='0' * 64), Path(self.directory.name) / 'other.bin')

    def test_https_is_required_by_default(self):
        with self.assertRaises(TransferError):
            transfer(self.route(require_https=True), self.target)

    def test_redirects_stay_on_route_and_never_carry_the_credential(self):
        transfer(self.route('/redirect-same'), self.target, credential=('Authorization', 'Bearer secret-value'))
        self.assertEqual(SEEN, [('/redirect-same', 'Bearer secret-value'), ('/file', None)])
        for path in ('/redirect-away', '/redirect-userinfo'):
            with self.assertRaises(TransferError) as caught:
                transfer(self.route(path), Path(self.directory.name) / 'x.bin', credential=('Authorization', 'Bearer secret-value'))
            self.assertNotIn('secret-value', str(caught.exception))

    def test_size_limit(self):
        with self.assertRaises(TransferError):
            transfer(self.route('/big'), self.target)
        self.assertFalse(self.target.exists())

    def test_resume_only_with_the_same_basis(self):
        partial = transfer(self.route('/truncated'), self.target)
        self.assertFalse(partial.complete)
        resumed = transfer(self.route(), self.target)
        self.assertTrue(resumed.resumed and resumed.complete)
        self.assertEqual(self.target.read_bytes(), BODY)
        # The upstream changed while a partial file waited: start a distinct input from zero.
        self.target.unlink()
        transfer(self.route('/truncated'), self.target)
        Handler.etag = '"v2"'
        fresh = transfer(self.route(), self.target)
        self.assertTrue(fresh.new_basis and not fresh.resumed and fresh.complete)
        self.assertEqual((fresh.upstream_basis, self.target.read_bytes()), ('etag:"v2"', BODY))


if __name__ == '__main__':
    unittest.main()

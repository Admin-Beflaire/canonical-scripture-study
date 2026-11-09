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
    truncate = False  # next plain /file answer drops after 400 bytes

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
        if self.path == '/chunked-drop':
            self.send_response(200)
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            self.wfile.write(b'190\r\n' + BODY[:400] + b'\r\n')  # one chunk, then the connection drops
            self.close_connection = True
            return
        if self.path == '/truncated' or (self.path == '/file' and Handler.truncate and not self.headers.get('Range')):
            Handler.truncate = False
            self.send_response(200)
            self.send_header('Content-Length', str(len(BODY)))
            self.send_header('ETag', Handler.etag)
            self.end_headers()
            self.wfile.write(BODY[:400])
            self.close_connection = True
            return
        if self.path not in ('/file', '/big', '/other'):
            self.send_error(404)
            return
        body = BODY * 20 if self.path == '/big' else BODY.upper().replace(b'0', b'X') if self.path == '/other' else BODY
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
        Handler.truncate = False

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

    def test_interrupted_transfer_of_unknown_length_is_not_complete(self):
        result = transfer(self.route('/chunked-drop'), self.target)
        self.assertFalse(result.complete)
        self.assertFalse(self.target.exists())

    def test_bad_saved_state_and_digest_mismatch_do_not_block_retries(self):
        Handler.truncate = True
        transfer(self.route(), self.target)
        self.target.with_name('original.bin.basis').write_text('{trunc')
        self.assertTrue(transfer(self.route(), self.target).complete)
        other = Path(self.directory.name) / 'other.bin'
        with self.assertRaises(TransferError):
            transfer(self.route(expected_sha256='0' * 64), other)
        self.assertFalse(other.with_name('other.bin.part').exists())
        self.assertTrue(transfer(self.route(), other).complete)

    def test_partial_from_another_url_is_never_continued(self):
        transfer(self.route('/truncated'), self.target)
        result = transfer(self.route('/other'), self.target)  # same ETag, different resource
        self.assertTrue(result.complete and not result.resumed)
        self.assertEqual(self.target.read_bytes(), BODY.replace(b'0', b'X'))

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
        Handler.truncate = True
        partial = transfer(self.route(), self.target)
        self.assertFalse(partial.complete)
        resumed = transfer(self.route(), self.target)
        self.assertTrue(resumed.resumed and resumed.complete)
        self.assertEqual(self.target.read_bytes(), BODY)
        # The upstream changed while a partial file waited: start a distinct input from zero.
        self.target.unlink()
        Handler.truncate = True
        transfer(self.route(), self.target)
        Handler.etag = '"v2"'
        fresh = transfer(self.route(), self.target)
        self.assertTrue(fresh.new_basis and not fresh.resumed and fresh.complete)
        self.assertEqual((fresh.upstream_basis, self.target.read_bytes()), ('etag:"v2"', BODY))


if __name__ == '__main__':
    unittest.main()

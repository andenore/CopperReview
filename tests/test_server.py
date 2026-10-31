import json
import hashlib
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from copper_review.__main__ import make_handler


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "test-token"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def request(self,path,body=None,**headers):
        data=json.dumps(body).encode() if body is not None else None
        return urlopen(Request(self.url+path,data=data,headers=headers))

    def test_static_and_token_access(self):
        with self.request('/') as response:
            self.assertIn(b'CopperReview',response.read())
            self.assertIn("frame-ancestors 'none'",response.headers['Content-Security-Policy'])
            self.assertIn("connect-src 'self' https:",response.headers['Content-Security-Policy'])
        for path, symbol in [('/projects.js', b'discoverProject'), ('/project-compiler.js', b'compileGithubProject')]:
            with self.request(path) as response:
                self.assertEqual(response.headers['Content-Type'], 'text/javascript; charset=utf-8')
                self.assertIn(symbol,response.read())
        with self.request('/copper-logo.svg') as response:
            self.assertEqual(response.headers['Content-Type'], 'image/svg+xml')
            self.assertIn(b'Copper Cu mark', response.read())
        with self.assertRaises(HTTPError) as ctx:
            self.request('/api/scene')
        self.assertEqual(ctx.exception.code,403)
        with self.request('/api/scene',**{'X-Copper-Token':'test-token'}) as response:
            self.assertIsNone(json.load(response))

    def test_cross_origin_and_host_rejected(self):
        for headers in [{'Origin':'https://example.com','X-Copper-Token':'test-token'},{'Host':'evil.example'}]:
            with self.assertRaises(HTTPError) as ctx:
                self.request('/api/scene',**headers)
            self.assertEqual(ctx.exception.code,403)

    def test_import_errors_preserve_scene_and_dont_expose_files(self):
        with self.assertRaises(HTTPError) as ctx:
            self.request('/api/import',{'filename':'board.kicad_pcb','text':'(broken'},**{'X-Copper-Token':'test-token'})
        self.assertEqual(ctx.exception.code,400)
        with self.assertRaises(HTTPError) as ctx:
            self.request('/../pyproject.toml')
        self.assertEqual(ctx.exception.code,404)

    def test_binary_import_hashes_original_bytes_including_bom(self):
        raw = b'\xef\xbb\xbf(kicad_pcb\r\n (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))\r\n'
        request = Request(self.url+'/api/import',data=raw,headers={
            'X-Copper-Token':'test-token','Content-Type':'application/octet-stream','X-Copper-Filename':'test%20board.kicad_pcb'})
        with urlopen(request) as response:
            scene = json.load(response)
        self.assertEqual(scene['board']['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(scene['board']['filename'],'test board.kicad_pcb')


if __name__ == '__main__':
    unittest.main()

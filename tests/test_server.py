import json
import hashlib
import threading
import unittest
from pathlib import Path
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
        # Every module the page imports is served (a missing one leaves every button dead).
        web = Path(__file__).resolve().parents[1] / 'copper_review' / 'web'
        for script in sorted(web.glob('*.js')):
            with self.request('/' + script.name) as response:
                self.assertEqual(response.headers['Content-Type'], 'text/javascript; charset=utf-8')
                self.assertEqual(response.read(), script.read_bytes())
        for blocked in ['/web/app.js', '/wasm/../app.js', '/%2e%2e/pyproject.toml', '/.hidden.js', '/demo.json']:
            with self.assertRaises(HTTPError) as ctx:
                self.request(blocked)
            self.assertEqual(ctx.exception.code, 404, blocked)
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


class ProjectServerTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name) / "Bench"
        (root / "src").mkdir(parents=True)
        (root / ".git").mkdir()
        (root / "board.copper").write_text("board Bench { }")
        (root / "src" / "part.copper").write_text("module Part { }")
        (root / "copper.mod").write_text("module example/bench\n")
        (root / "notes.txt").write_text("not served")
        (root / ".git" / "hidden.copper").write_text("module Hidden { }")
        (Path(self.dir.name) / "outside.copper").write_text("module Outside { }")
        self.root = root

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.dir.cleanup()

    def start(self, public=False):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "test-token", self.root, None, public=public))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def get(self, path, **headers):
        return urlopen(Request(self.url + path, headers={"X-Copper-Token": "test-token", **headers}))

    def test_project_lists_and_serves_only_sources_fresh(self):
        self.start()
        with self.get("/api/project") as response:
            project = json.load(response)
        self.assertEqual(project["name"], "Bench")
        self.assertEqual(sorted(f["path"] for f in project["files"]), ["board.copper", "copper.mod", "src/part.copper"])
        (self.root / "board.copper").write_text("board Bench { component R: RESISTOR; }")
        with self.get("/api/project/file?path=board.copper") as response:
            self.assertIn(b"RESISTOR", response.read())
        for path in ["notes.txt", "../outside.copper", ".git/hidden.copper", "src/../../outside.copper", ""]:
            with self.assertRaises(HTTPError) as ctx:
                self.get("/api/project/file?path=" + path)
            self.assertEqual(ctx.exception.code, 404, path)
        with self.assertRaises(HTTPError) as ctx:
            urlopen(Request(self.url + "/api/project/file?path=board.copper"))
        self.assertEqual(ctx.exception.code, 403)

    def test_network_mode_accepts_any_host_but_still_needs_the_token(self):
        self.start(public=True)
        with self.get("/api/project", Host="192.168.1.90:8791") as response:
            self.assertEqual(json.load(response)["name"], "Bench")
        with self.assertRaises(HTTPError) as ctx:
            urlopen(Request(self.url + "/api/project", headers={"Host": "192.168.1.90:8791"}))
        self.assertEqual(ctx.exception.code, 403)
        with self.assertRaises(HTTPError) as ctx:
            self.get("/api/project", Host="192.168.1.90:8791", Origin="https://example.com")
        self.assertEqual(ctx.exception.code, 403)


class BoardAssetTests(unittest.TestCase):
    def test_only_wrl_models_in_a_3dshapes_folder_beside_the_board_are_served(self):
        import tempfile
        from copper_review.__main__ import board_asset
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Board.3dshapes").mkdir()
            (root / "Board.3dshapes" / "a.wrl").write_bytes(b"#VRML V2.0 utf8\n")
            (root / "Board.3dshapes" / "a.step").write_bytes(b"step")
            (root / "secret.wrl").write_bytes(b"no")
            (root / "plain").mkdir()
            (root / "plain" / "a.wrl").write_bytes(b"no")
            self.assertEqual(board_asset(root, "Board.3dshapes/a.wrl"), b"#VRML V2.0 utf8\n")
            for name in ["Board.3dshapes/a.step", "secret.wrl", "plain/a.wrl", "Board.3dshapes/missing.wrl", "../x.3dshapes/a.wrl",
                         "Board.3dshapes/../secret.wrl", "/Board.3dshapes/a.wrl", "Board.3dshapes\\a.wrl", "", "a/b/c.wrl"]:
                self.assertIsNone(board_asset(root, name), name)
            self.assertIsNone(board_asset(None, "Board.3dshapes/a.wrl"))

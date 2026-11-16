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

    def test_step_reader_assets_are_served_only_from_their_own_folder(self):
        from copper_review.__main__ import static_asset
        self.assertEqual(static_asset('/occt/occt-import-js.wasm'), ('occt/occt-import-js.wasm', 'application/wasm'))
        self.assertEqual(static_asset('/occt/license.occt.txt')[1], 'text/plain; charset=utf-8')
        self.assertEqual(static_asset('/occt/manifest.json')[1], 'application/json')
        for blocked in ['/license.txt', '/manifest.json', '/occt/../app.js', '/other/x.js', '/occt/sub/x.js']:
            self.assertIsNone(static_asset(blocked), blocked)

    def test_only_the_step_worker_may_evaluate_javascript(self):
        # occt-import-js (the STEP reader) evaluates generated JavaScript inside its worker.
        with self.request('/step-worker.js') as response:
            self.assertIn("'unsafe-eval'", response.headers['Content-Security-Policy'])
            self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        for path in ['/', '/app.js', '/body-worker.js', '/compiler-worker.js']:
            with self.request(path) as response:
                self.assertNotIn("'unsafe-eval'", response.headers['Content-Security-Policy'], path)

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
        (root / "assembly.lock").write_text('{"schema": "copperscript-assembly-lock/v0.4", "board": "Bench", "selections": []}\n')
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
        self.assertEqual(sorted(f["path"] for f in project["files"]), ["assembly.lock", "board.copper", "copper.mod", "src/part.copper"])
        (self.root / "board.copper").write_text("board Bench { component R: RESISTOR; }")
        with self.get("/api/project/file?path=board.copper") as response:
            self.assertIn(b"RESISTOR", response.read())
        with self.get("/api/project/file?path=assembly.lock") as response:
            self.assertIn(b"copperscript-assembly-lock", response.read())
        with self.get("/api/project/file?path=src/part.copper") as response:
            self.assertTrue(response.read())
        for path in ["notes.txt", "../outside.copper", ".git/hidden.copper", "src/../../outside.copper", "",
                     "/etc/passwd.copper", "src\part.copper", str(self.root.parent / "outside.copper")]:
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
    def test_only_wrl_and_step_models_in_a_3dshapes_folder_beside_the_board_are_served(self):
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
            for name in ["Board.3dshapes/a.txt", "Board.3dshapes/a.step.bak", "secret.wrl", "plain/a.wrl", "Board.3dshapes/missing.wrl", "../x.3dshapes/a.wrl",
                         "Board.3dshapes/../secret.wrl", "/Board.3dshapes/a.wrl", "Board.3dshapes\\a.wrl", "", "a/b/c.wrl",
                         "C:Board.3dshapes/a.wrl", "Board.3dshapes/C:a.wrl", ".3dshapes/a.wrl", "Board.3dshapes/a\x00.wrl"]:
                self.assertIsNone(board_asset(root, name), name)
            self.assertEqual(board_asset(root, "Board.3dshapes/a.step"), b"step")
            (root / "Board.3dshapes" / "b.STP").write_bytes(b"stp")
            self.assertEqual(board_asset(root, "Board.3dshapes/b.STP"), b"stp")
            self.assertIsNone(board_asset(None, "Board.3dshapes/a.wrl"))


class RouteReportTests(unittest.TestCase):
    """`--route-report`: only the `emi` section of a run report travels to the page."""

    def report(self, directory, **changes):
        report = json.loads((Path(__file__).parent.parent / "examples" / "emi-buck.route-report.json").read_text(encoding="utf-8"))
        report["summary"] = {"report_path": "/home/someone/run/route-report.json"}
        report.update(changes)
        path = Path(directory) / "route-report.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        return path

    def test_the_section_is_served_with_the_file_name_and_hash_but_nothing_else_of_the_report(self):
        import tempfile
        from copper_review.__main__ import load_route_report
        with tempfile.TemporaryDirectory() as directory:
            path = self.report(directory)
            served = load_route_report(path)
            self.assertEqual(sorted(served), ["emi", "file", "schema", "sha256"])
            self.assertEqual(served["file"], "route-report.json")
            self.assertEqual(served["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(served["emi"]["schema"], "copperscript-emi-check/v0.1")
            self.assertNotIn("someone", json.dumps(served))
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "test-token", route_report=served))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/api/route-report"
                with urlopen(Request(url, headers={"X-Copper-Token": "test-token"})) as response:
                    body = json.load(response)
                self.assertEqual(len(body["emi"]["findings"]), 5)
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(url)
                self.assertEqual(ctx.exception.code, 403)
            finally:
                server.shutdown(); server.server_close(); thread.join()

    def test_a_report_without_the_section_is_served_without_it_and_other_json_is_refused(self):
        import tempfile
        from copper_review.__main__ import load_route_report
        with tempfile.TemporaryDirectory() as directory:
            bare = self.report(directory)
            data = json.loads(bare.read_text(encoding="utf-8")); del data["emi"]; bare.write_text(json.dumps(data), encoding="utf-8")
            self.assertNotIn("emi", load_route_report(bare))
            other = Path(directory) / "other.json"
            other.write_text(json.dumps({"schema": "copperscript-ir/v0.1"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_route_report(other)
            other.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_route_report(other)

    def test_no_report_means_an_empty_answer_not_an_error(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "test-token"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(f"http://127.0.0.1:{server.server_port}/api/route-report", headers={"X-Copper-Token": "test-token"})
            with urlopen(request) as response:
                self.assertIsNone(json.load(response))
        finally:
            server.shutdown(); server.server_close(); thread.join()

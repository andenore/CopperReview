"""Loopback-only server and standalone scene export CLI."""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
from urllib.parse import unquote
import webbrowser

from .importer import STAGES, import_pcb
from .electrical import import_electrical

WEB = Path(__file__).parent / "web"
MAX_UPLOAD = 50 * 1024 * 1024


def source_identity(path):
    if not path:
        return None
    path = Path(path)
    return {"filename": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def make_handler(initial_scene, token):
    class Handler(BaseHTTPRequestHandler):
        scene = initial_scene

        def send(self, status, payload, content_type="application/json; charset=utf-8"):
            if not isinstance(payload, bytes):
                payload = json.dumps(payload, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(payload)

        def allowed(self, auth=False):
            host = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != host:
                self.send(403, {"error": "Invalid local host"})
                return False
            if auth and not secrets.compare_digest(self.headers.get("X-Copper-Token", ""), token):
                self.send(403, {"error": "Invalid session token; use the URL printed by the CLI"})
                return False
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{host}":
                self.send(403, {"error": "Cross-origin requests are not allowed"})
                return False
            return True

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if not self.allowed(auth=path.startswith("/api/")):
                return
            if path == "/api/scene":
                self.send(200, type(self).scene)
                return
            files = {"/": ("index.html", "text/html; charset=utf-8"),
                     "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                     "/compiler.js": ("compiler.js", "text/javascript; charset=utf-8"),
                     "/documents.js": ("documents.js", "text/javascript; charset=utf-8"),
                     "/projects.js": ("projects.js", "text/javascript; charset=utf-8"),
                     "/project-compiler.js": ("project-compiler.js", "text/javascript; charset=utf-8"),
                     "/compiler-worker.js": ("compiler-worker.js", "text/javascript; charset=utf-8"),
                     "/example.copper": ("example.copper", "text/plain; charset=utf-8"),
                     "/wasm/copper_web.js": ("wasm/copper_web.js", "text/javascript; charset=utf-8"),
                     "/wasm/copper_web_bg.wasm": ("wasm/copper_web_bg.wasm", "application/wasm"),
                     "/wasm/manifest.json": ("wasm/manifest.json", "application/json"),
                     "/core.js": ("core.js", "text/javascript; charset=utf-8"),
                     "/style.css": ("style.css", "text/css; charset=utf-8"),
                     "/topology.js": ("topology.js", "text/javascript; charset=utf-8"),
                     "/electrical.js": ("electrical.js", "text/javascript; charset=utf-8"),
                     "/electrical-model.js": ("electrical-model.js", "text/javascript; charset=utf-8"),
                     "/copper-logo.svg": ("copper-logo.svg", "image/svg+xml")}
            if path not in files:
                self.send(404, {"error": "Not found"})
                return
            name, mime = files[path]
            if not (WEB / name).is_file():
                self.send(404, {"error": "Asset unavailable; build WASM assets before compiling source"})
                return
            self.send(200, (WEB / name).read_bytes(), mime)

        def do_POST(self):
            if not self.allowed(auth=True):
                return
            if self.path != "/api/import":
                self.send(404, {"error": "Not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_UPLOAD:
                    self.send(413, {"error": "Upload must be between 1 byte and 50 MiB"})
                    return
                data = self.rfile.read(length)
                if self.headers.get("Content-Type", "").split(";", 1)[0] == "application/octet-stream":
                    # Preserve original bytes (BOM, newlines, UTF-8) for the identity hash.
                    filename = unquote(self.headers.get("X-Copper-Filename", "board.kicad_pcb"))
                    scene = import_electrical(data, filename) if filename.lower().endswith(".json") else import_pcb(data, filename)
                else:
                    value = json.loads(data)
                    if not isinstance(value, dict) or not isinstance(value.get("text"), str) or not isinstance(value.get("filename"), str):
                        raise ValueError("Expected filename and PCB text")
                    scene = import_pcb(value["text"].encode("utf-8"), value["filename"], stage=value.get("stage", "unknown"))
                type(self).scene = scene
                self.send(200, scene)
            except (ValueError, TypeError, IndexError, KeyError, UnicodeError, OverflowError) as exc:
                self.send(400, {"error": f"Could not import design: {exc}"})

        def log_message(self, format, *args):
            # Avoid logging reviewer-supplied text or filesystem paths.
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description="Inspect PCB geometry and export review annotations without KiCad")
    parser.add_argument("board", nargs="?", type=Path, help="CopperScript .kicad_pcb export (omit to open the file picker)")
    parser.add_argument("--electrical-ir", type=Path, help="CopperScript compiled electrical IR JSON (no PCB required)")
    parser.add_argument("--stage", choices=STAGES, default="unknown", help="Declared review stage, not a verified routing status")
    parser.add_argument("--source", type=Path, help="Optional .copper source whose filename and hash accompany the board")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 selects an available port")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--export-scene", type=Path, help="Write a portable normalized scene JSON and exit")
    args = parser.parse_args()
    try:
        if args.board and args.board.stat().st_size > MAX_UPLOAD:
            parser.error("Board exceeds 50 MiB")
        if args.board and args.electrical_ir:
            parser.error("Choose a PCB or --electrical-ir, not both")
        electrical_path = args.electrical_ir or (args.board if args.board and args.board.suffix.lower() == '.json' else None)
        if electrical_path and electrical_path.stat().st_size > MAX_UPLOAD:
            parser.error("Electrical IR exceeds 50 MiB")
        scene = import_electrical(electrical_path.read_bytes(), electrical_path.name) if electrical_path else (
            import_pcb(args.board.read_bytes(), args.board.name, stage=args.stage,
                       source=source_identity(args.source)) if args.board else None)
        if args.export_scene:
            if scene is None:
                parser.error("--export-scene requires a board")
            args.export_scene.write_text(json.dumps(scene, indent=2, allow_nan=False)+"\n", encoding="utf-8")
            print(f"Scene saved: {args.export_scene.resolve()}")
            return
        token = secrets.token_urlsafe(32)
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(scene, token))
        server.daemon_threads = True
        url = f"http://127.0.0.1:{server.server_port}/#token={token}"
        print(f"CopperReview: {url}", flush=True)
        print("Read-only PCB inspection. Annotations save in this browser; export JSON to keep/share them. Ctrl+C stops the server.", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    except (OSError, ValueError, UnicodeError) as exc:
        parser.exit(2, f"CopperReview: {exc}\n")


if __name__ == "__main__":
    main()

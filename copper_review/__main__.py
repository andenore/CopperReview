"""Loopback-only server and standalone scene export CLI."""
from __future__ import annotations

import argparse
import hashlib
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import socket
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser

from .importer import STAGES, import_pcb
from .electrical import import_electrical

WEB = Path(__file__).parent / "web"
MAX_UPLOAD = 50 * 1024 * 1024
MAX_MODEL = 32 * 1024 * 1024
MODEL_TYPES = {".wrl": "model/vrml", ".step": "application/octet-stream", ".stp": "application/octet-stream"}
# Every web asset of these types is served, so a new module cannot be left out.
STATIC_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml", ".copper": "text/plain; charset=utf-8",
                ".wasm": "application/wasm", ".json": "application/json"}


CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; "
       "img-src 'self' blob:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'")
# The STEP reader (occt-import-js, Emscripten) evaluates generated JavaScript, which `script-src`
# without 'unsafe-eval' refuses. A dedicated worker takes its policy from its own script's response,
# so only that worker, which has no DOM and talks to the page by messages, is allowed to.
STEP_WORKER = "step-worker.js"
STEP_WORKER_CSP = CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'")


def static_asset(path):
    """Map a request path to (file, type) under web/, web/wasm/ or web/occt/ (the STEP reader), or None."""
    if path == "/":
        return "index.html", "text/html; charset=utf-8"
    name = path[1:]
    parts = name.split("/")
    if len(parts) > 2 or (len(parts) == 2 and parts[0] not in ("wasm", "occt")):
        return None
    if not all(re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", part) for part in parts):
        return None
    suffix = Path(name).suffix
    if suffix == ".json" and parts[0] not in ("wasm", "occt"):
        return None
    if suffix == ".txt":
        return (name, "text/plain; charset=utf-8") if parts[0] == "occt" else None
    mime = STATIC_TYPES.get(suffix)
    return (name, mime) if mime else None


# A served project exposes only CopperScript sources and manifests, read fresh per request.
PROJECT_SKIP = {".git", ".copper-cache", "node_modules", "target"}
# assembly.lock is read by the Assembly mode, never by the compiler.
PROJECT_MANIFESTS = ("copper.mod", "copper.lock", "assembly.lock")
MAX_PROJECT_SOURCE = 512 * 1024
MAX_PROJECT_MANIFEST = 8 * 1024 * 1024
MAX_PROJECT_FILES = 2000


def project_files(root):
    """Folder-relative paths of .copper sources, copper.mod/copper.lock and assembly.lock, without symlinks."""
    root = Path(root).resolve()
    found = {}
    for directory, folders, names in os.walk(root):
        folders[:] = sorted(f for f in folders if f not in PROJECT_SKIP and not (Path(directory) / f).is_symlink())
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink() or not (name.endswith(".copper") or name in PROJECT_MANIFESTS):
                continue
            limit = MAX_PROJECT_SOURCE if name.endswith(".copper") else MAX_PROJECT_MANIFEST
            size = path.stat().st_size
            if size > limit:
                continue
            found[path.relative_to(root).as_posix()] = size
            if len(found) > MAX_PROJECT_FILES:
                raise ValueError(f"Project has more than {MAX_PROJECT_FILES} source files")
    return found


def project_file(root, name):
    """The file a project listing would include at folder-relative `name`, or None; no tree walk."""
    root = Path(root).resolve()
    parts = name.split("/") if isinstance(name, str) else []
    if not parts or any(part in ("", ".", "..") or part in PROJECT_SKIP for part in parts):
        return None
    leaf = parts[-1]
    if not (leaf.endswith(".copper") or leaf in PROJECT_MANIFESTS):
        return None
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            return None
    if not path.is_file() or path.resolve().parent != root.joinpath(*parts[:-1]).resolve():
        return None
    limit = MAX_PROJECT_SOURCE if leaf.endswith(".copper") else MAX_PROJECT_MANIFEST
    return path if path.stat().st_size <= limit else None


def lan_addresses():
    """Best-effort addresses another machine can use to reach this one."""
    addresses = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # No packet is sent; this only picks the outbound interface.
            addresses.add(probe.getsockname()[0])
    except OSError:
        pass
    try:
        addresses.update(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return sorted(a for a in addresses if not a.startswith("127.")) or ["127.0.0.1"]


def source_identity(path):
    if not path:
        return None
    path = Path(path)
    return {"filename": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def board_asset(root, name):
    """Bytes of `<dir>.3dshapes/<file>.wrl|step|stp` beside the board, or None; nothing else is served."""
    parts = name.split("/") if root and isinstance(name, str) and "\\" not in name else []
    # Plain file names only: no drive letters, NUL or leading dots, which pathlib could join outside root.
    if (len(parts) != 2 or not parts[0].endswith(".3dshapes") or Path(parts[1]).suffix.lower() not in MODEL_TYPES
            or any(not part or part.startswith(".") or any(c in part for c in (":", "\x00")) for part in parts)):
        return None
    root = Path(root).resolve()
    directory = root / parts[0]
    path = directory / parts[1]
    try:
        if directory.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MODEL:
            return None
        if path.resolve().parent != directory.resolve() or directory.resolve().parent != root:
            return None
        return path.read_bytes()
    except OSError:
        return None


def make_handler(initial_scene, token, project=None, board=None, public=False, board_dir=None):
    project = Path(project).resolve() if project else None

    class Handler(BaseHTTPRequestHandler):
        scene = initial_scene

        def send(self, status, payload, content_type="application/json; charset=utf-8", csp=CSP):
            if not isinstance(payload, bytes):
                payload = json.dumps(payload, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", csp)
            self.end_headers()
            self.wfile.write(payload)

        def allowed(self, auth=False):
            # Loopback servers accept only their own Host (DNS rebinding); a server bound to the
            # network is reached by many names and relies on the session token for its API.
            host = self.headers.get("Host", "") if public else f"127.0.0.1:{self.server.server_port}"
            if not host or self.headers.get("Host") != host:
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
            if path == "/api/project":
                if not project:
                    self.send(200, None)
                    return
                try:
                    files = project_files(project)
                except (OSError, ValueError) as exc:
                    self.send(500, {"error": f"Could not read project: {exc}"})
                    return
                listing = {"name": project.name, "board": board, "files": [{"path": p, "size": s} for p, s in files.items()]}
                if not public:
                    listing["root"] = str(project)  # For "Open in VS Code" links; not sent to other machines.
                self.send(200, listing)
                return
            if path == "/api/board-asset":
                model = parse_qs(urlsplit(self.path).query).get("path", [""])[0]
                data = board_asset(board_dir, model)
                if data is None:
                    self.send(404, {"error": "Not a 3D model beside the board"})
                    return
                self.send(200, data, MODEL_TYPES[Path(model).suffix.lower()])
                return
            if path == "/api/project/file":
                name = parse_qs(urlsplit(self.path).query).get("path", [""])[0]
                try:
                    found = project_file(project, name) if project else None
                    data = found.read_bytes() if found else None
                except OSError:
                    data = None
                if data is None:
                    self.send(404, {"error": "Not a project source file"})
                    return
                self.send(200, data, "application/octet-stream")
                return
            asset = static_asset(path)
            if not asset or not ((WEB / asset[0]).is_file() or asset[0].startswith("wasm/")):
                self.send(404, {"error": "Not found"})
                return
            name, mime = asset
            if not (WEB / name).is_file():
                self.send(404, {"error": "Asset unavailable; run npm run fetch:wasm before compiling source"})
                return
            self.send(200, (WEB / name).read_bytes(), mime, STEP_WORKER_CSP if name == STEP_WORKER else CSP)

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
    parser.add_argument("board", nargs="?", type=Path, help="CopperScript .kicad_pcb export (omit to open the file picker); with --project, the board to review next to its schematic")
    parser.add_argument("--electrical-ir", type=Path, help="CopperScript compiled electrical IR JSON (no PCB required)")
    parser.add_argument("--stage", choices=STAGES, default="unknown", help="Declared review stage, not a verified routing status")
    parser.add_argument("--source", type=Path, help="Optional .copper source whose filename and hash accompany the board")
    parser.add_argument("--project", type=Path, help="CopperScript project folder; the browser compiles it on every page load")
    parser.add_argument("--entry", help="Board source inside --project when the folder has several (e.g. boards/main/board.copper)")
    parser.add_argument("--host", default="127.0.0.1", help="Address to listen on; 0.0.0.0 serves other machines on your network (plain HTTP)")
    parser.add_argument("--port", type=int, default=0, help="Port; 0 selects an available port")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--export-scene", type=Path, help="Write a portable normalized scene JSON and exit")
    args = parser.parse_args()
    try:
        if args.board and args.board.stat().st_size > MAX_UPLOAD:
            parser.error("Board exceeds 50 MiB")
        if args.board and args.electrical_ir:
            parser.error("Choose a PCB or --electrical-ir, not both")
        if args.project and args.electrical_ir:
            parser.error("Choose --project or --electrical-ir, not both")
        if args.project and args.board and args.board.suffix.lower() == ".json":
            parser.error("With --project, the board must be a .kicad_pcb export")
        if args.entry and not args.project:
            parser.error("--entry needs --project")
        if args.project:
            if not args.project.is_dir():
                parser.error(f"Project folder not found: {args.project}")
            files = project_files(args.project)
            if args.entry and args.entry.replace("\\", "/") not in files:
                parser.error(f"--entry {args.entry} is not a .copper file in {args.project}")
            if not any(p.endswith(".copper") for p in files):
                parser.error(f"No .copper sources in {args.project}")
            if not (WEB / "wasm" / "manifest.json").is_file():
                print("CopperReview: the browser compiler is missing; run `npm run fetch:wasm` in the CopperReview checkout (or `npm run build:wasm` with Rust and CopperScript).", flush=True)
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
        public = args.host not in ("127.0.0.1", "localhost")
        entry = args.entry.replace("\\", "/") if args.entry else None
        server = ThreadingHTTPServer((args.host, args.port), make_handler(
            scene, token, args.project, entry, public=public,
            board_dir=args.board.resolve().parent if args.board and args.board.suffix.lower() == ".kicad_pcb" else None))
        server.daemon_threads = True
        url = f"http://127.0.0.1:{server.server_port}/#token={token}"
        print(f"CopperReview: {url}", flush=True)
        if public:
            hosts = lan_addresses() if args.host in ("0.0.0.0", "") else [args.host]
            for host in hosts:
                print(f"  network: http://{host}:{server.server_port}/#token={token}", flush=True)
            print("Served over plain HTTP to your network. Anyone with the link (including its token) can read "
                  "the design" + (" and its project sources" if args.project else "") + "; share it only on networks you trust.", flush=True)
        if args.project:
            print(f"Project: {args.project.resolve()} (reload the page to recompile after editing)", flush=True)
        print("Read-only inspection. Annotations save in this browser; export JSON to keep/share them. Ctrl+C stops the server.", flush=True)
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

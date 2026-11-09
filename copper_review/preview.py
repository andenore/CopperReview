"""Read-only, debounced snapshots for the local live preview. No build commands."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import threading
import time

from .importer import import_pcb

MAX_SNAPSHOT = 8 * 1024 * 1024
MAX_BOARD = 50 * 1024 * 1024


class LivePreview:
    def __init__(self, project=None, entry=None, board=None, stage="unknown", listing=None, resolve=None):
        self.project = Path(project).resolve() if project else None
        self.board = Path(board).absolute() if board else None
        self.entry, self.stage, self.listing, self.resolve = entry, stage, listing, resolve
        self.lock = threading.RLock()
        self.checked = -float("inf")
        self.channels = {kind: {"state": "settling", "revision": None, "error": ""}
                         for kind, path in (("source", self.project), ("layout", self.board)) if path}
        self.signatures, self.since, self.completed, self.payloads = {}, {}, {}, {}

    @staticmethod
    def stamp(path):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Watched file is missing or is a symlink")
        stat = path.stat()
        return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino

    def inventory(self, kind):
        if kind == "layout":
            stamp = self.stamp(self.board)
            if stamp[0] > MAX_BOARD:
                raise ValueError("Board exceeds 50 MiB")
            return (("", stamp),)
        files = self.listing(self.project)
        if sum(files.values()) > MAX_SNAPSHOT:
            raise ValueError("Live project snapshot exceeds 8 MiB")
        result = []
        for name in sorted(files):
            path = self.resolve(self.project, name)
            if path is None:
                raise ValueError("Project changed while reading its inventory")
            result.append((name, self.stamp(path)))
        return tuple(result)

    def read(self, kind, signature):
        if kind == "layout":
            raw = self.board.read_bytes()
            if len(raw) > MAX_BOARD:
                raise ValueError("Board exceeds 50 MiB")
            return hashlib.sha256(raw).hexdigest(), import_pcb(raw, self.board.name, stage=self.stage), None
        files, hashes, total = {}, {}, 0
        for name, _ in signature:
            path = self.resolve(self.project, name)
            if path is None:
                raise ValueError("Project file disappeared while reading")
            raw = path.read_bytes()
            total += len(raw)
            if total > MAX_SNAPSHOT:
                raise ValueError("Live project snapshot exceeds 8 MiB")
            files[name] = raw.decode("utf-8")
            hashes[name] = hashlib.sha256(raw).hexdigest()
        revision = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return revision, {"name": self.project.name, "root": str(self.project), "entry": self.entry, "files": files}, hashes

    def status(self):
        with self.lock:
            clock = time.monotonic()
            if clock - self.checked >= .25:
                self.checked = clock
                for kind, channel in self.channels.items():
                    signature = None
                    try:
                        signature = self.inventory(kind)
                        if self.signatures.get(kind) != signature:
                            self.signatures[kind], self.since[kind] = signature, clock
                            channel.update(state="settling", error="")
                        if self.completed.get(kind) == signature:
                            continue
                        if clock - self.since[kind] < .6:
                            continue
                        revision, payload, hashes = self.read(kind, signature)
                        if self.inventory(kind) != signature:
                            channel.update(state="settling", error="")
                            continue
                        self.payloads[kind] = payload
                        self.completed[kind] = signature
                        channel.update(state="ready", revision=revision, error="")
                        if hashes is not None:
                            channel["files"] = hashes
                    except (OSError, ValueError, UnicodeError) as exc:
                        channel.update(state="error", error=str(exc)[:3000])
                        # Retry a failed read only after the inputs change.
                        if signature is None or isinstance(exc, OSError):
                            self.signatures.pop(kind, None)
                            self.completed.pop(kind, None)
                        else:
                            self.completed[kind] = signature
            return {"enabled": True, **deepcopy(self.channels)}

    def snapshot(self, kind, revision):
        with self.lock:
            if kind not in self.channels:
                raise ValueError("Unknown preview kind")
            status = self.status().get(kind)
            if not status or status["state"] != "ready" or status["revision"] != revision:
                raise ValueError("Preview changed; read its status again")
            return {"revision": revision, "data": self.payloads[kind]}

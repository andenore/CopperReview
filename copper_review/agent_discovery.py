"""Per-user discovery of local viewers; credentials never enter the repository."""
import base64
import ctypes
import json
import os
from pathlib import Path
import stat
import uuid
from . import __version__


def registry_dir():
    override = os.environ.get("COPPER_REVIEW_REGISTRY")
    if override:
        return Path(override)
    if os.name == "nt":
        return Path(os.environ["LOCALAPPDATA"]) / "CopperReview" / "agents"
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))) / "copper-review" / "agents"


def protect(data, decrypt=False):
    """Windows DPAPI, bound to this user, with no interactive prompt."""
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    raw = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, result = Blob(len(data), raw), Blob()
    library = ctypes.WinDLL("crypt32", use_last_error=True)
    operation = library.CryptUnprotectData if decrypt else library.CryptProtectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise OSError("Could not protect or read the local agent discovery credential")
    release = ctypes.WinDLL("kernel32").LocalFree
    release.argtypes, release.restype = [ctypes.c_void_p], ctypes.c_void_p
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        release(result.data)


def _private_directory(root, create=False):
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink():
        raise ValueError("Agent discovery directory cannot be a symlink")
    if os.name != "nt" and root.exists():
        info = root.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError("Agent discovery directory must be owned by you with permissions 0700")


def advertise(url, label, project):
    root = registry_dir()
    _private_directory(root, create=True)
    viewer_id = str(uuid.uuid4())
    record = {"schema": "copper-review-discovery/v1", "id": viewer_id, "label": label,
              "project": str(Path(project).resolve()), "pid": os.getpid(), "version": __version__}
    if os.name == "nt":
        record["protected_url"] = base64.b64encode(protect(url.encode())).decode()
    else:
        record["url"] = url
    # Exclusive new file, with POSIX permissions established before any credentials are written.
    path = root / f"{viewer_id}.json"
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
        json.dump(record, stream)
    return path


def process_alive(pid):
    """Return False only when the recorded process is known to have exited."""
    if type(pid) is not int or pid <= 0:
        return None
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False if ctypes.get_last_error() == 87 else None
        try:
            result = kernel.WaitForSingleObject(handle, 0)
            return False if result == 0 else True if result == 258 else None
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return None


def candidates():
    root = registry_dir()
    _private_directory(root)
    records = []
    # Prefer recently started viewers when old crash records have accumulated.
    paths = []
    for path in root.glob("*.json"):
        try:
            paths.append((path.stat().st_mtime, path))
        except OSError:
            continue
    for _, path in sorted(paths, reverse=True):
        try:
            if path.is_symlink() or path.stat().st_size > 16384:
                continue
            info = path.stat()
            if os.name != "nt" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict) or record.get("schema") != "copper-review-discovery/v1":
                continue
            if not isinstance(record.get("id"), str) or str(uuid.UUID(record["id"])) != path.stem:
                continue
            if process_alive(record.get("pid")) is False:
                path.unlink()
                continue
            if len(records) >= 64:
                continue
            if os.name == "nt":
                record["url"] = protect(base64.b64decode(record["protected_url"], validate=True), decrypt=True).decode()
            if not all(isinstance(record.get(k), str) for k in ("id", "label", "project", "url")):
                continue
            records.append(record)
        except (OSError, ValueError, KeyError, UnicodeError, TypeError):
            continue
    return records

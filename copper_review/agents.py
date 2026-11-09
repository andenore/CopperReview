"""Bounded, in-memory review mailbox. No models, shell commands or board writes."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import re
import threading
import time
import uuid

MAX_CONTEXT = 4 * 1024 * 1024
MAX_REQUESTS = 32
MAX_SESSIONS = 8
SESSION_TTL = 3600
SESSION_IDLE = 120
CLAIM_TTL = 300
LAYOUT_CATEGORIES = {"placement", "routing", "package_escape", "return_path", "mechanical", "algorithm", "other"}
ELECTRICAL_CATEGORIES = {"connectivity", "power", "interface", "part_choice", "protection", "other"}


def now():
    return datetime.now(timezone.utc).isoformat()


def text(value, label, limit=16000, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f"Invalid {label}")
    return value


def identity(document):
    return document.get("sha256") if isinstance(document, dict) else None


def json_preview(value, limit=3000):
    """Serialize only the prefix we will display, including for very large string leaves."""
    def chunks(item):
        if isinstance(item, dict):
            yield "{"
            for index, (key, val) in enumerate(item.items()):
                if index:
                    yield ","
                yield json.dumps(key[:limit + 1], ensure_ascii=False)
                yield ":"
                yield from chunks(val)
            yield "}"
        elif isinstance(item, list):
            yield "["
            for index, val in enumerate(item):
                if index:
                    yield ","
                yield from chunks(val)
            yield "]"
        else:
            yield json.dumps(item[:limit + 1] if isinstance(item, str) else item, ensure_ascii=False, allow_nan=False)
    parts, length = [], 0
    for chunk in chunks(value):
        parts.append(chunk[:max(0, limit - length)])
        length += len(chunk)
        if length > limit:
            return "".join(parts), True
    return "".join(parts), False


class AgentBridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.sessions = {}
        self.requests = {}
        self.workers = {}
        self.clients = {}

    def client_activity(self, client, selected=None):
        if client is None:
            return
        if not isinstance(client, dict):
            raise ValueError("Invalid client metadata")
        cid = str(uuid.UUID(text(client.get("id"), "client id", 100)))
        name = text(client.get("name"), "client name", 100)
        with self.lock:
            if cid not in self.clients and len(self.clients) >= 16:
                oldest = min(self.clients, key=lambda k: self.clients[k]["seen"])
                del self.clients[oldest]
                for session in self.sessions.values():
                    session.get("client_reads", {}).pop(oldest, None)
            self.clients[cid] = {"name": name, "seen": time.monotonic(), "last_seen_at": now()}
            if selected and selected["session_id"] in self.sessions:
                session = self.sessions[selected["session_id"]]
                session.setdefault("client_reads", {})[cid] = {"revision": selected["revision"], "read_at": now()}
                test = session.get("connection_test")
                if test and test["status"] == "waiting" and time.monotonic() < test["until"] and test["revision"] == selected["revision"] == session["digest"].hex():
                    test.update(status="passed", host=name)

    def connection_test(self, sid):
        with self.lock:
            self._expire()
            _, session = self._current_session(sid)
            if not session["context"]["documents"]:
                raise ValueError("Open a design before testing the connection")
            session["connection_test"] = {"status": "waiting", "revision": session["digest"].hex(), "until": time.monotonic() + 120}
            return {"status": "waiting", "prompt": 'Use CopperReview get_current_selection with session_id ' + json.dumps(sid) +
                    '. Tell me what is selected and which design is open. Do not change the design.'}

    def _expire(self):
        expired = {sid for sid, s in self.sessions.items() if time.monotonic() - s["seen"] > SESSION_TTL}
        for sid in expired:
            del self.sessions[sid]
        self.requests = {rid: r for rid, r in self.requests.items() if r["session_id"] not in expired}
        for r in self.requests.values():
            if r["status"] == "answering" and time.monotonic() >= r.get("lease_until", 0):
                r["status"] = "queued"
                for key in ("claim_id", "lease_until", "claimed_by", "progress"):
                    r.pop(key, None)

    def _active(self, session):
        return session.get("attached", True) and time.monotonic() - session["seen"] < SESSION_IDLE

    def detach(self, sid):
        with self.changed:
            if sid in self.sessions:
                self.sessions[sid]["attached"] = False
            self.changed.notify_all()
            return {"detached": True}

    def _session(self, sid):
        text(sid, "session id", 100)
        if sid not in self.sessions:
            raise ValueError("Review tab unavailable; reopen Ask about design in the browser")
        return self.sessions[sid]

    def _request(self, rid):
        text(rid, "request id", 100)
        if rid not in self.requests:
            raise ValueError("Review request unavailable or expired")
        return self.requests[rid]

    def context(self, sid, context):
        text(sid, "session id", 100)
        if not isinstance(context, dict) or context.get("schema") != "copper-review-agent-context/v1":
            raise ValueError("Invalid review context")
        documents = context.get("documents")
        if not isinstance(documents, dict) or set(documents) - {"layout", "electrical"}:
            raise ValueError("Invalid context documents")
        for doc in documents.values():
            if not isinstance(doc, dict) or not re.fullmatch(r"[0-9a-f]{64}", str(identity(doc))):
                raise ValueError("Context needs exact design hashes")
        encoded = json.dumps(context, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_CONTEXT:
            raise ValueError("Selection context exceeds 4 MiB; narrow the review or reduce notes")
        digest = hashlib.sha256(encoded).digest()
        with self.lock:
            self._expire()
            if sid not in self.sessions and len(self.sessions) >= MAX_SESSIONS:
                idle = [key for key, s in self.sessions.items() if not self._active(s)]
                if not idle:
                    raise ValueError("Eight review tabs are active; close an unused tab and try again")
                oldest = min(idle, key=lambda key: self.sessions[key]["seen"])
                del self.sessions[oldest]
                self.requests = {key: r for key, r in self.requests.items() if r["session_id"] != oldest}
            previous = self.sessions.get(sid)
            captured = previous["context"] if previous and previous["digest"] == digest else deepcopy(context)
            self.sessions[sid] = {**(previous or {}), "context": captured, "digest": digest, "seen": time.monotonic(), "updated_at": now(), "attached": True}
            return {"session_id": sid}

    def _current_session(self, sid=None):
        if sid is None:
            active = [key for key, session in self.sessions.items() if self._active(session)]
            if not active:
                raise ValueError("No live review tab; open the viewer started with --agents")
            if len(active) != 1:
                raise ValueError("Several review tabs are active; use list_sessions and select_session or pass session_id")
            sid = active[0]
        session = self._session(sid)
        if not self._active(session):
            raise ValueError("Review tab is idle; return to the viewer before using its selection")
        return sid, session

    def current_selection(self, sid=None):
        with self.lock:
            self._expire()
            sid, session = self._current_session(sid)
            return {"session_id": sid, "revision": session["digest"].hex(),
                    "synchronized_at": session["updated_at"], "context": deepcopy(session["context"])}

    def show_on_board(self, target, digest, selection, sid=None):
        with self.lock:
            self._expire()
            sid, session = self._current_session(sid)
            doc = session["context"]["documents"].get(target)
            if target not in ("layout", "electrical") or not doc or identity(doc) != digest:
                raise ValueError("Navigation hash does not match the current design; read get_current_selection again")
            self._validate_selection(target, doc, selection)
            command = {"command_id": str(uuid.uuid4()), "target": target, "sha256": digest,
                       "selection": deepcopy(selection), "status": "queued", "expires_at": time.time() + 30}
            session["navigation"] = command
            session["navigation_until"] = time.monotonic() + 30
            return {"session_id": sid, **deepcopy(command)}

    def navigation(self, sid, command_id=None):
        with self.lock:
            self._expire()
            session = self._session(sid)
            command = session.get("navigation")
            if command_id is not None and (not command or command["command_id"] != command_id):
                raise ValueError("Navigation unavailable or superseded by a newer highlight")
            if command and command["status"] == "queued" and time.monotonic() >= session["navigation_until"]:
                command.update(status="expired")
            return deepcopy(command)

    def acknowledge_navigation(self, sid, command_id, status, reason=""):
        text(command_id, "command id", 100)
        if status not in ("applied", "rejected"):
            raise ValueError("Invalid navigation result")
        text(reason, "navigation reason", 300, empty=True)
        with self.lock:
            command = self.navigation(sid, command_id)
            if command["status"] == "queued":
                self.sessions[sid]["navigation"].update(status=status, reason=reason)
            return self.navigation(sid, command_id)

    def enqueue(self, sid, prompt, parent_id=None, context=None):
        text(prompt, "review prompt")
        with self.lock:
            self._expire()
            if context is not None:
                self.context(sid, context)
            session = self._session(sid)
            if not session["context"]["documents"]:
                raise ValueError("Open a design before requesting review")
            if parent_id and self._request(parent_id)["session_id"] != sid:
                raise ValueError("Reply belongs to another review tab")
            if len(self.requests) >= MAX_REQUESTS:
                # Never silently discard pending work.
                completed = next((rid for rid, r in self.requests.items() if r["status"] not in ("queued", "answering") and rid != parent_id), None)
                if completed is None:
                    raise ValueError("32 reviews are pending; wait for the agent or restart the server")
                del self.requests[completed]
            rid = str(uuid.uuid4())
            self.requests[rid] = {"id": rid, "session_id": sid, "created_at": now(), "prompt": prompt,
                                  "parent_id": parent_id, "status": "queued", "context": session["context"]}
            self.changed.notify_all()
            return {"request_id": rid, "status": "queued"}

    def sessions_list(self):
        with self.lock:
            self._expire()
            return [{"session_id": sid, "updated_at": s["updated_at"], "active": self._active(s), "revision": s["digest"].hex(),
                     "documents": {k: {"sha256": d["sha256"], "name": d.get("name")} for k, d in s["context"]["documents"].items()}}
                    for sid, s in self.sessions.items()]

    def get_context(self, sid):
        with self.lock:
            self._expire()
            return deepcopy(self._session(sid)["context"])

    def list_requests(self, sid=None, status=None):
        if status not in (None, "queued", "answering", "completed", "stale", "cancelled"):
            raise ValueError("Invalid request status")
        with self.lock:
            self._expire()
            return [{k: deepcopy(v) for k, v in r.items() if k not in ("context", "feedback", "answer", "lease_until", "claim_id")}
                    for r in self.requests.values() if (sid is None or r["session_id"] == sid) and (status is None or r["status"] == status)]

    def get_request(self, rid):
        with self.lock:
            self._expire()
            return deepcopy(self._request(rid))

    def updates(self, sid):
        with self.lock:
            self._expire()
            self._session(sid).update(seen=time.monotonic(), attached=True)
            return [{k: deepcopy(v) for k, v in r.items() if k not in ("context", "lease_until", "claim_id")}
                    for r in self.requests.values() if r["session_id"] == sid]

    def wait_for_question(self, agent, sid=None, timeout=30):
        text(agent, "agent name", 200)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 <= timeout <= 45:
            raise ValueError("Wait timeout must be between 0 and 45 seconds")
        deadline = time.monotonic() + timeout
        with self.changed:
            self._expire()
            if sid is not None:
                self._session(sid)
            # Presence is bounded and carries no authentication claim about the agent name.
            self.workers = {k: v for k, v in self.workers.items() if time.monotonic() - v["seen"] < CLAIM_TTL}
            if self.workers.get(agent, {}).get("waiting"):
                raise ValueError("This agent already has an active wait")
            if agent not in self.workers and len(self.workers) >= 16:
                raise ValueError("Too many agent workers; wait for idle workers to expire")
            self.workers[agent] = {"seen": time.monotonic(), "session_id": sid, "waiting": True}
            try:
                while True:
                    self._expire()
                    for r in self.requests.values():
                        if r["status"] == "queued" and self._active(self.sessions[r["session_id"]]) and (sid is None or sid == r["session_id"]):
                            r.update(status="answering", claimed_by=agent, claim_id=str(uuid.uuid4()), lease_until=time.monotonic() + CLAIM_TTL)
                            return deepcopy(r)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    self.changed.wait(min(remaining, 1))
            finally:
                self.workers[agent]["waiting"] = False
                self.workers[agent]["seen"] = time.monotonic()

    def agent_status(self, sid):
        with self.lock:
            self._expire()
            session = self._session(sid)
            test = session.get("connection_test")
            if test and test["status"] in ("waiting", "passed"):
                if test["revision"] != session["digest"].hex():
                    test["status"] = "selection_changed"
                elif test["status"] == "waiting" and time.monotonic() >= test["until"]:
                    test["status"] = "expired"
            connections = []
            for cid, client in self.clients.items():
                read = session.get("client_reads", {}).get(cid, {})
                connections.append({"name": client["name"], "connected": time.monotonic() - client["seen"] < 15,
                                    "last_seen_at": client["last_seen_at"], "read_at": read.get("read_at"),
                                    "read_current": read.get("revision") == session["digest"].hex()})
            active = {r["claimed_by"] for r in self.requests.values() if r["session_id"] == sid and r["status"] == "answering"}
            return {"connections": connections, "connection_test": {k: v for k, v in (test or {}).items() if k in ("status", "host")},
                    "agents": [{"name": name, "state": "answering" if name in active else "waiting" if w["waiting"] else "idle"}
                               for name, w in self.workers.items() if (w["session_id"] in (None, sid)) and
                               (time.monotonic() - w["seen"] < 60 or name in active)]}

    def cancel(self, sid, rid):
        with self.changed:
            r = self._request(rid)
            if r["session_id"] != sid:
                raise ValueError("Question belongs to another review tab")
            if r["status"] in ("queued", "answering"):
                r["status"] = "cancelled"
                self.changed.notify_all()
            return {"status": r["status"]}

    def _check_claim(self, r, claim_id, agent):
        if r["status"] in ("cancelled", "completed", "stale"):
            raise ValueError("Question is no longer active")
        text(claim_id, "claim id; call wait_for_question before publishing", 100)
        if r["status"] == "answering":
            if r.get("claim_id") != claim_id or r.get("claimed_by") != agent:
                raise ValueError("Question is claimed by a different worker")
            r["lease_until"] = time.monotonic() + CLAIM_TTL
        else:
            raise ValueError("Question claim expired; wait for a new claim")

    def progress(self, rid, claim_id, agent, message):
        text(message, "progress", 1000)
        with self.lock:
            self._expire()
            r = self._request(rid)
            self._check_claim(r, claim_id, agent)
            r["progress"] = message
            if agent in self.workers:
                self.workers[agent]["seen"] = time.monotonic()
            return {"status": r["status"]}

    @staticmethod
    def resolve_pointer(context, pointer):
        if not isinstance(pointer, str) or not pointer.startswith("/documents/") or len(pointer) > 2000:
            raise ValueError("Evidence pointer must address a document in the captured question context")
        value = context
        try:
            for part in pointer.split("/")[1:]:
                if re.search(r"~(?![01])", part):
                    raise ValueError("Invalid JSON pointer escape")
                key = part.replace("~1", "/").replace("~0", "~")
                if isinstance(value, list):
                    if not re.fullmatch(r"0|[1-9][0-9]*", key):
                        raise ValueError("Invalid array index")
                    value = value[int(key)]
                elif isinstance(value, dict):
                    value = value[key]
                else:
                    raise ValueError("Evidence pointer does not resolve")
        except (KeyError, IndexError):
            raise ValueError("Evidence pointer does not resolve") from None
        return value

    def publish_answer(self, value):
        rid = text(value.get("request_id"), "request id", 100)
        text(value.get("answer_id"), "answer id", 100)
        text(value.get("agent"), "agent name", 200)
        text(value.get("answer"), "answer", 32000)
        text(value.get("limitations", ""), "limitations", empty=True)
        based_on, citations = value.get("based_on"), value.get("citations", [])
        if not isinstance(based_on, dict) or not based_on or set(based_on) - {"layout", "electrical"}:
            raise ValueError("Answer needs the exact hashes of the documents used")
        if not isinstance(citations, list) or len(citations) > 32:
            raise ValueError("Expected at most 32 evidence references")
        with self.lock:
            self._expire()
            r = self._request(rid)
            if "answer" in r:
                if r["answer"]["payload"] == value:
                    return {"status": r["status"], "request_id": rid}
                raise ValueError("Question already answered; ask a follow-up")
            self._check_claim(r, value.get("claim_id"), value["agent"])
            docs = r["context"]["documents"]
            for target, digest in based_on.items():
                if not docs.get(target) or identity(docs[target]) != digest:
                    raise ValueError("Answer hash does not match the captured design")
            evidence = []
            for cite in citations:
                if not isinstance(cite, dict):
                    raise ValueError("Invalid evidence reference")
                text(cite.get("label"), "evidence label", 300)
                pointer = cite.get("pointer")
                resolved = self.resolve_pointer(r["context"], pointer)
                target = pointer.split("/")[2]
                if target not in based_on:
                    raise ValueError("Cited document must be included in based_on")
                if "selection" in cite:
                    self._validate_selection(target, docs[target], cite["selection"])
                preview, truncated = json_preview(resolved)
                evidence.append({**deepcopy(cite), "target": target, "sha256": based_on[target],
                                 "excerpt": preview, "truncated": truncated})
            current = self._session(r["session_id"])["context"]["documents"]
            r["status"] = "completed" if all(identity(current.get(t)) == h for t, h in based_on.items()) else "stale"
            r["answer"] = {"payload": deepcopy(value), "created_at": now(), "evidence": evidence}
            return {"status": r["status"], "request_id": rid}

    def publish(self, value):
        if not isinstance(value, dict):
            raise ValueError("Expected feedback object")
        rid = text(value.get("request_id"), "request id", 100)
        text(value.get("feedback_id"), "feedback id", 100)
        text(value.get("agent"), "agent name", 200)
        text(value.get("summary"), "summary", empty=True)
        target = value.get("target")
        if target not in ("layout", "electrical"):
            raise ValueError("Feedback target must be layout or electrical")
        findings = value.get("findings")
        if not isinstance(findings, list) or len(findings) > 32:
            raise ValueError("Expected at most 32 findings")
        with self.lock:
            self._expire()
            request = self._request(rid)
            if request["status"] == "cancelled" or "answer" in request:
                raise ValueError("Question is no longer active")
            doc = request["context"]["documents"].get(target)
            if not doc or value.get("sha256") != identity(doc):
                raise ValueError("Feedback hash does not match the requested design")
            for finding in findings:
                if not isinstance(finding, dict):
                    raise ValueError("Invalid finding")
                text(finding.get("observation"), "observation")
                text(finding.get("desired_behavior", ""), "desired behavior", empty=True)
                if finding.get("category", "other") not in (LAYOUT_CATEGORIES if target == "layout" else ELECTRICAL_CATEGORIES):
                    raise ValueError("Invalid finding category")
                if finding.get("priority", "medium") not in ("low", "medium", "high"):
                    raise ValueError("Invalid finding priority")
                selection = finding.get("selection", doc.get("selection"))
                if target == "electrical" and selection is None:
                    raise ValueError("No electrical entity was selected; supply an explicit finding selection")
                self._validate_selection(target, doc, selection)
            # Retries must be byte-equivalent in meaning; never duplicate annotations.
            if "feedback" in request:
                if request["feedback"]["payload"] != value:
                    raise ValueError("Request already completed; create a follow-up review")
                return {"status": request["status"], "request_id": rid}
            self._check_claim(request, value.get("claim_id"), value["agent"])
            current = self._session(request["session_id"])["context"]["documents"].get(target)
            request["status"] = "completed" if identity(current) == identity(doc) else "stale"
            request["feedback"] = {"payload": deepcopy(value), "created_at": now(),
                                   "annotations": [{**deepcopy(f), "id": str(uuid.uuid4()),
                                                    "selection": deepcopy(f.get("selection", doc.get("selection")))} for f in findings],
                                   "visible_layers": deepcopy(doc.get("visible_layers", [])),
                                   "view": doc.get("view"), "power_state": doc.get("power_state")}
            return {"status": request["status"], "request_id": rid}

    @staticmethod
    def _validate_selection(target, doc, selection):
        if not isinstance(selection, dict):
            raise ValueError("Finding needs an exact entity selection")
        entities = doc.get("entities", {})
        if target == "electrical":
            if selection.get("id") not in entities.get(selection.get("kind"), []):
                raise ValueError("Finding references an unknown electrical entity")
            return
        for kind in ("components", "nets"):
            values = selection.get(kind)
            if not isinstance(values, list) or any(not isinstance(v, str) or v not in entities.get(kind, []) for v in values):
                raise ValueError("Finding references an unknown layout entity")
        region = selection.get("region")
        if region is not None and (not isinstance(region, list) or len(region) != 4 or
                                   any(type(v) not in (int, float) or not math.isfinite(v) for v in region) or
                                   region[0] > region[2] or region[1] > region[3]):
            raise ValueError("Invalid finding region")

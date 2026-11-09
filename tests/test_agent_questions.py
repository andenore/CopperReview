import json
import os
from pathlib import Path
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from copper_review.agents import AgentBridge
from copper_review.agent_discovery import advertise, candidates
from copper_review.agent_mcp import DiscoveryClient
from copper_review.__main__ import make_handler
from test_agents import context, feedback


def answer(rid, claim=None):
    return {"request_id": rid, "answer_id": "answer-1", "agent": "Helper", "answer": "U1 is the selected component.",
            "based_on": {"layout": "a" * 64}, "citations": [{"label": "Selected component", "pointer": "/documents/layout/selection/components/0",
                                                           "selection": {"components": ["U1"], "nets": [], "region": None}}],
            **({"claim_id": claim} if claim else {})}


class QuestionsTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AgentBridge()
        self.bridge.context("tab", context())

    def question(self):
        return self.bridge.enqueue("tab", "What is U1?")["request_id"]

    def test_wait_wakes_and_claims_only_once(self):
        started = threading.Event()
        results = []
        def work():
            started.set()
            results.append(self.bridge.wait_for_question("Helper", timeout=2))
        thread = threading.Thread(target=work)
        thread.start()
        started.wait(1)
        rid = self.question()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0]["id"], rid)
        self.assertEqual(results[0]["status"], "answering")
        self.assertIsNone(self.bridge.wait_for_question("Second helper", timeout=0))
        self.assertEqual(self.bridge.agent_status("tab")["agents"][0]["state"], "answering")

    def test_answer_contains_real_evidence_and_is_not_a_finding(self):
        rid = self.question()
        claim = self.bridge.wait_for_question("Helper", timeout=0)
        value = answer(rid, claim["claim_id"])
        self.assertEqual(self.bridge.publish_answer(value)["status"], "completed")
        r = self.bridge.get_request(rid)
        self.assertNotIn("feedback", r)
        self.assertEqual(r["answer"]["evidence"][0]["excerpt"], '"U1"')
        self.assertEqual(self.bridge.publish_answer(value)["status"], "completed")
        with self.assertRaisesRegex(ValueError, "already answered"):
            self.bridge.publish_answer({**value, "answer": "changed"})

    def test_evidence_must_resolve_and_use_a_declared_hash(self):
        rid = self.question()
        claim = self.bridge.wait_for_question("Helper", timeout=0)["claim_id"]
        for pointer in ["/documents/layout/missing", "/documents/layout/selection/components/-1", "/documents/layout/selection/components/01", "/mode", "/documents/layout/~2bad"]:
            value = answer(rid, claim)
            value["citations"][0]["pointer"] = pointer
            with self.assertRaises(ValueError):
                self.bridge.publish_answer(value)
        with self.assertRaisesRegex(ValueError, "hash"):
            self.bridge.publish_answer({**answer(rid, claim), "based_on": {"layout": "b" * 64}})
        self.assertEqual(self.bridge.get_request(rid)["status"], "answering")

    def test_cancel_and_expired_claims_cannot_publish(self):
        rid = self.question()
        claim = self.bridge.wait_for_question("Helper", timeout=0)["claim_id"]
        self.bridge.progress(rid, claim, "Helper", "Checking pins")
        self.assertEqual(self.bridge.get_request(rid)["progress"], "Checking pins")
        self.bridge.cancel("tab", rid)
        with self.assertRaisesRegex(ValueError, "no longer active"):
            self.bridge.publish_answer(answer(rid, claim))
        rid2 = self.question()
        old = self.bridge.wait_for_question("Helper", timeout=0)["claim_id"]
        self.bridge.requests[rid2]["lease_until"] = 0
        new = self.bridge.wait_for_question("Other", timeout=0)
        self.assertNotEqual(old, new["claim_id"])
        with self.assertRaisesRegex(ValueError, "different worker"):
            self.bridge.publish_answer(answer(rid2, old))

    def test_stale_answer_remains_readable_but_bound_to_old_hash(self):
        rid = self.question()
        claim = self.bridge.wait_for_question("Helper", timeout=0)["claim_id"]
        self.bridge.context("tab", context("b" * 64))
        self.assertEqual(self.bridge.publish_answer(answer(rid, claim))["status"], "stale")
        self.assertEqual(self.bridge.updates("tab")[0]["answer"]["evidence"][0]["sha256"], "a" * 64)

    def test_wait_is_bounded_and_session_scoped(self):
        self.bridge.context("other", context())
        self.question()
        self.assertIsNone(self.bridge.wait_for_question("Helper", sid="other", timeout=0))
        for seconds in [-1, 46, float("nan"), True]:
            with self.assertRaises(ValueError):
                self.bridge.wait_for_question("Helper", timeout=seconds)

    def test_optional_findings_respect_question_ownership(self):
        rid = self.question()
        claim = self.bridge.wait_for_question("Helper", timeout=0)
        value = {**feedback(rid), "agent": "Helper"}
        with self.assertRaisesRegex(ValueError, "claim"):
            self.bridge.publish(value)
        value["claim_id"] = claim["claim_id"]
        self.assertEqual(self.bridge.publish(value)["status"], "completed")


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"COPPER_REVIEW_REGISTRY": str(Path(self.directory.name) / "registry")})
        self.env.start()
        self.servers = []

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            server.server_close()
            thread.join()
        self.env.stop()
        self.directory.cleanup()

    def viewer(self, label="board", project="project"):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "browser-token", agents=True, agent_token="secret-token"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        url = f"http://127.0.0.1:{server.server_port}/#token=secret-token"
        path = advertise(url, label, Path(self.directory.name) / project)
        return server, thread, path

    def browser(self, server, path, body=None):
        request = Request(f"http://127.0.0.1:{server.server_port}/api/agents" + path,
                          None if body is None else json.dumps(body).encode(),
                          {"X-Copper-Token": "browser-token", "Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def tab(self, server, sid, used):
        self.browser(server, "/context", {"session_id": sid, "context": context()})
        self.browser(server, "/activity", {"session_id": sid, "last_used": used})

    def test_discovery_uses_protected_credentials_and_omits_them_from_tool_output(self):
        _, _, path = self.viewer()
        record = candidates()[0]
        self.assertIn("secret-token", record["url"])
        if os.name == "nt":
            self.assertNotIn("secret-token", path.read_text())
        else:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        client = DiscoveryClient()
        self.assertEqual(client("list_sessions", {}), [])
        visible = client("list_viewers", {})
        self.assertEqual(visible[0]["label"], "board")
        self.assertNotIn("secret-token", json.dumps(visible))

    def test_explicit_viewer_survives_focus_changes_and_reconnects_after_restart(self):
        first, thread, old_path = self.viewer("A", "A")
        second, _, _ = self.viewer("B", "B")
        self.tab(first, "a-tab", time.time() - 10)
        self.tab(second, "b-tab", time.time())
        client = DiscoveryClient()
        self.assertEqual(client("get_current_selection", {})["session_id"], "b-tab")
        choice = next(v for v in client("list_viewers", {}) if v["label"] == "A")
        client("select_viewer", {"viewer_id": choice["id"]})
        self.assertEqual(client("get_current_selection", {})["session_id"], "a-tab")
        client.discovery_until = time.monotonic() + 60
        first.shutdown(); first.server_close(); thread.join()
        self.servers.remove((first, thread))
        self.viewer("A restarted", "A")
        # A failed cached connection is not replayed; the next call rediscovers.
        with self.assertRaisesRegex(ValueError, "Cannot reach"):
            client("list_sessions", {})
        self.assertEqual(client("list_sessions", {}), [])
        self.assertTrue(old_path.exists())

    def test_heartbeat_and_reads_do_not_pin_viewer(self):
        first, thread, _ = self.viewer("A", "A")
        client = DiscoveryClient()
        self.assertTrue(client("_connection_ping", {})["connected"])
        self.assertEqual(client("list_sessions", {}), [])
        self.assertIsNone(client.project)
        self.assertIsNone(client.viewer_id)
        second, _, _ = self.viewer("B", "B")
        self.tab(first, "a-tab", time.time() - 10)
        self.tab(second, "b-tab", time.time())
        client.invalidate_discovery()
        self.assertEqual(client("get_current_selection", {})["session_id"], "b-tab")
        first.shutdown(); first.server_close(); thread.join()
        self.servers.remove((first, thread))
        self.assertEqual(client("list_sessions", {})[0]["session_id"], "b-tab")
        self.assertIsNone(client.project)

    def test_focus_routes_across_viewers_but_sessions_and_claims_keep_their_owner(self):
        first, _, _ = self.viewer("A", "A")
        second, _, _ = self.viewer("B", "B")
        self.tab(first, "a-tab", 0)
        client = DiscoveryClient()
        self.assertEqual(client("get_current_selection", {})["session_id"], "a-tab")
        self.tab(first, "a-tab", time.time() - 10)
        self.tab(second, "b-tab", time.time() - 5)
        client.invalidate_discovery()
        client("_connection_ping", {})
        for server, sid in [(first, "a-tab"), (second, "b-tab")]:
            self.assertTrue(self.browser(server, "/status?session_id=" + sid)["connections"][0]["connected"])
        selected = client("get_current_selection", {})
        self.assertEqual(selected["session_id"], "b-tab")
        self.assertEqual(selected["viewer"]["label"], "B")
        self.assertNotIn("secret-token", json.dumps(selected))
        question = self.browser(second, "/requests", {"session_id": "b-tab", "prompt": "Explain this"})
        claim = client("wait_for_question", {"agent": "Helper", "timeout_seconds": 0})
        self.assertEqual(claim["id"], question["request_id"])
        self.tab(first, "a-tab", time.time())
        client.invalidate_discovery()
        self.assertEqual(client("get_current_selection", {})["session_id"], "a-tab")
        self.assertEqual(client("get_current_selection", {"session_id": "b-tab"})["session_id"], "b-tab")
        client("report_progress", {"request_id": claim["id"], "claim_id": claim["claim_id"], "agent": "Helper", "message": "Reading"})
        self.assertEqual(client("get_request", {"request_id": claim["id"]})["progress"], "Reading")
        client("publish_answer", answer(claim["id"], claim["claim_id"]))
        self.assertEqual(self.browser(second, "/updates?session_id=b-tab")[0]["status"], "completed")

    def test_discovery_cache_is_shared_expires_and_manual_refresh_bypasses_it(self):
        record = {"id": "A", "url": "A"}
        client = DiscoveryClient()
        with patch("copper_review.agent_mcp.time.monotonic", return_value=10) as clock, patch(
                "copper_review.agent_mcp.candidates", return_value=[record]) as registry, patch(
                "copper_review.agent_mcp.connect", return_value=lambda name, args: []) as probe:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: client.live(), range(8)))
            self.assertEqual(registry.call_count, 1)
            self.assertEqual(probe.call_count, 1)
            clock.return_value = 12.1
            client.live()
            self.assertEqual(registry.call_count, 2)
            client.live(force=True)
            self.assertEqual(registry.call_count, 3)

    def test_version_warning_and_malformed_discovery_ids(self):
        import io
        from contextlib import redirect_stderr
        _, _, path = self.viewer()
        record = json.loads(path.read_text())
        record["version"] = "old"
        path.write_text(json.dumps(record))
        client = DiscoveryClient()
        output = io.StringIO()
        with redirect_stderr(output):
            client("list_sessions", {})
            client("list_sessions", {})
        self.assertEqual(output.getvalue().count("reinstall the extension"), 1)
        for invalid in [None, 123, {}, []]:
            record["id"] = invalid
            path.write_text(json.dumps(record))
            self.assertEqual(candidates(), [])

    def test_inflight_heartbeat_cannot_overwrite_explicit_selection(self):
        from copper_review import __version__
        client = DiscoveryClient()
        records = [{"id": name, "project": name, "url": name, "label": name, "version": __version__} for name in ("A", "B")]
        entered, release = threading.Event(), threading.Event()
        results = []
        def live(**kwargs):
            if threading.current_thread().name == "heartbeat-race":
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Timed out waiting for explicit selection")
                return records[:1]
            return records
        with patch.object(client, "live", side_effect=live), patch("copper_review.agent_mcp.connect", side_effect=lambda url, **kw: lambda name, args: url):
            worker = threading.Thread(name="heartbeat-race", target=lambda: results.append(client("_connection_ping", {})))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                client("select_viewer", {"viewer_id": "B"})
            finally:
                release.set()
                worker.join(5)
            self.assertEqual(results[0]["viewer_ids"], ["A"])  # Already in flight when the user selected B.
            self.assertEqual(client.project, "B")
            self.assertEqual(client("list_sessions", {}), "B")

    def test_adapter_can_start_before_viewer_and_project_filter_is_exact(self):
        project = Path(self.directory.name) / "selected"
        client = DiscoveryClient(project=project)
        with self.assertRaisesRegex(ValueError, "No matching"):
            client("list_sessions", {})
        self.viewer("other", "other")
        client.invalidate_discovery()
        with self.assertRaisesRegex(ValueError, "No matching"):
            client("list_sessions", {})
        self.viewer("selected", "selected")
        client.invalidate_discovery()
        self.assertEqual(client("list_sessions", {}), [])


if __name__ == "__main__":
    unittest.main()

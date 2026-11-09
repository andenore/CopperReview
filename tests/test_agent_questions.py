import json
import os
from pathlib import Path
import tempfile
import threading
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

    def test_multiple_viewers_require_selection_and_restart_reconnects_to_same_project(self):
        first, thread, old_path = self.viewer("A", "A")
        self.viewer("B", "B")
        client = DiscoveryClient()
        with self.assertRaisesRegex(ValueError, "Several"):
            client("list_sessions", {})
        choice = next(v for v in client("list_viewers", {}) if v["label"] == "A")
        client("select_viewer", {"viewer_id": choice["id"]})
        self.assertEqual(client("list_sessions", {}), [])
        first.shutdown(); first.server_close(); thread.join()
        self.servers.remove((first, thread))
        self.viewer("A restarted", "A")
        # A stale crash record is ignored. The failed operation is never replayed.
        with self.assertRaisesRegex(ValueError, "Cannot reach"):
            client("list_sessions", {})
        self.assertEqual(client("list_sessions", {}), [])
        self.assertTrue(old_path.exists())

    def test_adapter_can_start_before_viewer_and_project_filter_is_exact(self):
        project = Path(self.directory.name) / "selected"
        client = DiscoveryClient(project=project)
        with self.assertRaisesRegex(ValueError, "No matching"):
            client("list_sessions", {})
        self.viewer("other", "other")
        with self.assertRaisesRegex(ValueError, "No matching"):
            client("list_sessions", {})
        self.viewer("selected", "selected")
        self.assertEqual(client("list_sessions", {}), [])


if __name__ == "__main__":
    unittest.main()

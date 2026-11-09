import json
import os
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from copper_review.agents import AgentBridge, MAX_CONTEXT, MAX_SESSIONS, SESSION_IDLE, json_preview
from copper_review.agent_discovery import candidates, process_alive
import test_agents
from test_agents import context, feedback
import test_agent_questions
from test_agent_questions import answer


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AgentBridge()
        self.bridge.context("tab", context())

    def test_reconnect_reuses_session_and_preserves_questions(self):
        rid = self.bridge.enqueue("tab", "What is U1?")["request_id"]
        for _ in range(12):
            self.bridge.detach("tab")
            self.bridge.context("tab", context())
            self.assertEqual(self.bridge.updates("tab")[0]["id"], rid)
        self.assertEqual(len(self.bridge.sessions_list()), 1)

    def test_evicts_oldest_idle_session_and_its_questions(self):
        orphan = self.bridge.enqueue("tab", "Abandoned")["request_id"]
        for i in range(MAX_SESSIONS - 1):
            self.bridge.context(str(i), context())
        self.bridge.detach("tab")
        self.bridge.detach("0")
        self.bridge.context("new", context())
        self.assertNotIn("tab", self.bridge.sessions)
        self.assertNotIn(orphan, self.bridge.requests)
        self.assertIn("0", self.bridge.sessions)
        self.assertEqual(len(self.bridge.sessions), MAX_SESSIONS)
        self.bridge.updates("0")
        with self.assertRaisesRegex(ValueError, "active"):
            self.bridge.context("overflow", context())

    def test_detached_and_crashed_tabs_do_not_supply_new_work(self):
        rid = self.bridge.enqueue("tab", "Question")["request_id"]
        self.bridge.detach("tab")
        self.assertIsNone(self.bridge.wait_for_question("Helper", timeout=0))
        self.bridge.updates("tab")
        self.bridge.sessions["tab"]["seen"] = time.monotonic() - SESSION_IDLE - 1
        self.assertIsNone(self.bridge.wait_for_question("Helper", timeout=0))
        self.bridge.updates("tab")
        self.assertEqual(self.bridge.wait_for_question("Helper", timeout=0)["id"], rid)

    def test_immutable_context_is_shared_until_revision_changes(self):
        original = context()
        r1 = self.bridge.enqueue("tab", "First", context=original)["request_id"]
        r2 = self.bridge.enqueue("tab", "Second", context=original)["request_id"]
        self.assertIs(self.bridge.requests[r1]["context"], self.bridge.requests[r2]["context"])
        original["documents"]["layout"]["name"] = "Changed"
        self.bridge.context("tab", original)
        self.assertEqual(self.bridge.requests[r1]["context"]["documents"]["layout"]["name"], "Demo")
        self.assertIsNot(self.bridge.requests[r1]["context"], self.bridge.sessions["tab"]["context"])
        external = self.bridge.get_request(r1); external["context"]["documents"].clear()
        self.assertTrue(self.bridge.requests[r1]["context"]["documents"])

    def test_size_is_compact_utf8_and_exact_boundary_is_accepted(self):
        value = context()
        value["unicode"] = "µ" * 700000
        value["padding"] = ""
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        value["padding"] = "x" * (MAX_CONTEXT - len(encoded))
        self.bridge.context("tab", value)
        value["padding"] += "x"
        with self.assertRaisesRegex(ValueError, "4 MiB"):
            self.bridge.context("tab", value)

    def test_claim_is_required_even_for_queued_publications(self):
        rid = self.bridge.enqueue("tab", "Question")["request_id"]
        for publish, value in [(self.bridge.publish_answer, answer(rid)), (self.bridge.publish, feedback(rid))]:
            with self.assertRaisesRegex(ValueError, "claim"):
                publish(value)
        claim = self.bridge.wait_for_question("Helper", timeout=0)
        self.bridge.requests[rid]["lease_until"] = 0
        with self.assertRaisesRegex(ValueError, "expired"):
            self.bridge.publish_answer(answer(rid, claim["claim_id"]))

    def test_bounded_preview_does_not_visit_later_values(self):
        class Unserializable:
            pass
        value = ["x" * 1000000, Unserializable()]
        preview, truncated = json_preview(value)
        self.assertEqual(len(preview), 3000)
        self.assertTrue(truncated)
        self.assertEqual(json_preview({"µ": [1, True, None]}), ('{"µ":[1,true,null]}', False))

    def test_electrical_whole_design_findings_need_explicit_entity(self):
        self.bridge.context("tab", {"schema": "copper-review-agent-context/v1", "documents": {
            "electrical": {"sha256": "a" * 64, "selection": None, "entities": {"net": ["DATA"]}}}})
        rid = self.bridge.enqueue("tab", "Review")["request_id"]
        claim = self.bridge.wait_for_question("Test reviewer", timeout=0)
        value = {**feedback(rid, claim=claim["claim_id"]), "target": "electrical",
                 "findings": [{"observation": "Check DATA"}]}
        with self.assertRaisesRegex(ValueError, "explicit finding selection"):
            self.bridge.publish(value)
        value["findings"][0]["selection"] = {"kind": "net", "id": "DATA"}
        self.assertEqual(self.bridge.publish(value)["status"], "completed")


class CredentialTests(unittest.TestCase):
    setUp = test_agents.AgentHTTPTests.setUp
    tearDown = test_agents.AgentHTTPTests.tearDown
    request = test_agents.AgentHTTPTests.request

    def test_agent_credential_has_only_tool_access(self):
        headers = {"X-Copper-Token": self.server.RequestHandlerClass.agent_token}
        self.assertEqual(self.request("/api/agents/tool", {"name": "list_sessions"}, **headers), [])
        for path, body in [("/api/agents/context", {"session_id": "tab", "context": context()}),
                           ("/api/agents/requests", {"session_id": "tab", "prompt": "Injected"}),
                           ("/api/import", {}), ("/api/agents", None), ("/api/agents/detach", {"session_id": "tab"}),
                           ("/api/agents/navigation?session_id=tab", None),
                           ("/api/agents/navigation", {"session_id": "tab", "command_id": "x", "status": "applied"})]:
            with self.assertRaises(HTTPError) as error:
                self.request(path, body, **headers)
            self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.request("/api/agents/tool", {"name": "list_sessions"})
        self.assertEqual(error.exception.code, 403)

    def test_oversize_http_body_returns_readable_json(self):
        with self.assertRaises(HTTPError) as error:
            self.request("/api/agents/context", {"padding": "x" * (MAX_CONTEXT + 128 * 1024)})
        self.assertEqual(error.exception.code, 413)
        self.assertIn("error", json.load(error.exception))


class DiscoveryPruningTests(unittest.TestCase):
    setUp = test_agent_questions.DiscoveryTests.setUp
    tearDown = test_agent_questions.DiscoveryTests.tearDown
    viewer = test_agent_questions.DiscoveryTests.viewer

    def test_prunes_only_known_dead_process_records(self):
        _, _, dead = self.viewer()
        _, _, live = self.viewer()
        record = json.loads(dead.read_text())
        record["pid"] = 123456
        dead.write_text(json.dumps(record))
        with patch("copper_review.agent_discovery.process_alive", side_effect=lambda pid: False if pid == 123456 else None):
            self.assertEqual(len(candidates()), 1)
        self.assertFalse(dead.exists())
        self.assertTrue(live.exists())

    def test_process_check_detects_exit(self):
        self.assertTrue(process_alive(os.getpid()))
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        process.wait(timeout=10)
        self.assertFalse(process_alive(process.pid))
        self.assertIsNone(process_alive(-1))

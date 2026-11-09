from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from copper_review.agents import AgentBridge, MAX_REQUESTS
from copper_review.agent_mcp import Protocol, call_tool, connect
from copper_review.__main__ import make_handler


def context(digest="a" * 64):
    return {"schema": "copper-review-agent-context/v1", "mode": "layout", "documents": {
        "layout": {"sha256": digest, "name": "Demo", "selection": {"components": ["U1"], "nets": [], "region": None},
                   "visible_layers": ["F.Cu"], "entities": {"components": ["U1"], "nets": ["GND"]}}}}


def feedback(rid, digest="a" * 64):
    return {"request_id": rid, "feedback_id": "result-1", "target": "layout", "sha256": digest,
            "agent": "Test reviewer", "summary": "Inspect the selected area", "findings": [
                {"observation": "Check the return path", "category": "return_path", "priority": "high"}]}


class MailboxTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AgentBridge()
        self.bridge.context("tab", context())

    def request(self):
        return self.bridge.enqueue("tab", "Review U1")["request_id"]

    def test_request_is_immutable_and_feedback_is_idempotent(self):
        rid = self.request()
        changed = context()
        changed["documents"]["layout"]["selection"]["components"] = []
        self.bridge.context("tab", changed)
        self.assertEqual(self.bridge.get_request(rid)["context"], context())
        result = self.bridge.publish(feedback(rid))
        self.assertEqual(result["status"], "completed")
        before = self.bridge.updates("tab")
        self.assertEqual(self.bridge.publish(feedback(rid)), result)
        self.assertEqual(self.bridge.updates("tab"), before)
        annotation = before[0]["feedback"]["annotations"][0]
        self.assertEqual(annotation["selection"]["components"], ["U1"])
        altered = feedback(rid)
        altered["summary"] = "Different result"
        with self.assertRaisesRegex(ValueError, "already completed"):
            self.bridge.publish(altered)

    def test_revision_changes_are_stale_and_wrong_hashes_rejected(self):
        rid = self.request()
        with self.assertRaisesRegex(ValueError, "hash"):
            self.bridge.publish(feedback(rid, "c" * 64))
        self.bridge.context("tab", context("b" * 64))
        self.assertEqual(self.bridge.publish(feedback(rid))["status"], "stale")

    def test_unknown_entities_and_invalid_regions_reject_entire_batch(self):
        rid = self.request()
        for selection in [{"components": ["missing"], "nets": [], "region": None},
                          {"components": [], "nets": [], "region": [2, 0, 1, 1]},
                          {"components": [], "nets": [], "region": [0, 0, float("inf"), 1]}]:
            value = feedback(rid)
            value["findings"].append({"observation": "Bad target", "selection": selection})
            with self.assertRaises(ValueError):
                self.bridge.publish(value)
            self.assertEqual(self.bridge.get_request(rid)["status"], "queued")

    def test_tabs_and_replies_are_isolated(self):
        rid = self.request()
        self.bridge.context("other", context())
        with self.assertRaisesRegex(ValueError, "another review tab"):
            self.bridge.enqueue("other", "Reply", rid)
        reply = self.bridge.enqueue("tab", "Why?", rid)["request_id"]
        self.assertEqual(self.bridge.get_request(reply)["parent_id"], rid)
        self.assertEqual(self.bridge.updates("other"), [])

    def test_click_context_is_captured_atomically(self):
        clicked = context("b" * 64)
        rid = self.bridge.enqueue("tab", "Review this revision", context=clicked)["request_id"]
        clicked["documents"].clear()
        self.assertEqual(self.bridge.get_request(rid)["context"], context("b" * 64))

    def test_pending_queue_is_bounded(self):
        for _ in range(MAX_REQUESTS):
            self.request()
        with self.assertRaisesRegex(ValueError, "pending"):
            self.request()
        rid = self.bridge.list_requests()[0]["id"]
        self.bridge.publish(feedback(rid))
        self.request()
        self.assertEqual(len(self.bridge.list_requests()), MAX_REQUESTS)

    def test_electrical_findings_keep_entity_and_view(self):
        doc = {"sha256": "e" * 64, "selection": {"kind": "pin", "id": "U1.VCC"},
               "entities": {"pin": ["U1.VCC"]}, "view": "power", "power_state": "sleep"}
        self.bridge.context("tab", {"schema": "copper-review-agent-context/v1", "documents": {"electrical": doc}})
        rid = self.request()
        value = {**feedback(rid, "e" * 64), "target": "electrical", "findings": [{"observation": "Check supply", "category": "power"}]}
        self.bridge.publish(value)
        saved = self.bridge.get_request(rid)["feedback"]
        self.assertEqual(saved["annotations"][0]["selection"], doc["selection"])
        self.assertEqual(saved["power_state"], "sleep")

    def test_protocol_negotiation_notifications_and_errors(self):
        protocol = Protocol(lambda name, args: call_tool(self.bridge, name, args))
        request = lambda method, params={}: protocol.handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        self.assertIn("error", request("tools/list"))
        self.assertEqual(request("initialize", {"protocolVersion": "2024-11-05"})["result"]["protocolVersion"], "2024-11-05")
        self.assertIsNone(protocol.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        names = {t["name"] for t in request("tools/list")["result"]["tools"]}
        self.assertTrue({"wait_for_question", "publish_answer", "list_viewers"} <= names)
        self.assertTrue(request("tools/call", {"name": "unknown"})["result"]["isError"])
        self.assertIn("error", protocol.handle([]))

    def test_mcp_only_connects_to_explicit_loopback_urls(self):
        for url in ["https://example.org/#token=a", "http://localhost:123/#token=a", "http://127.0.0.1:123/", "http://a@127.0.0.1:123/#token=x"]:
            with self.assertRaises(ValueError):
                connect(url)


class AgentHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(None, "test-token", agents=True))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, **headers):
        data = json.dumps(body).encode() if body is not None else None
        with urlopen(Request(self.url + path, data, {"X-Copper-Token": "test-token", **headers})) as response:
            return json.load(response)

    def test_auth_origin_limits_and_disabled_mode(self):
        for headers in [{"X-Copper-Token": "bad"}, {"Origin": "https://evil.example"}, {"Host": "evil.example"}]:
            with self.assertRaises(HTTPError) as error:
                self.request("/api/agents/tool", {"name": "list_sessions"}, **headers)
            self.assertEqual(error.exception.code, 403)
        with self.assertRaises(ValueError):
            make_handler(None, "x", agents=True, public=True)
        self.assertTrue(self.request("/api/agents")["enabled"])
        with self.assertRaises(HTTPError):
            self.request("/api/agents/context", [])
        self.server.RequestHandlerClass = make_handler(None, "test-token")
        self.assertFalse(self.request("/api/agents")["enabled"])
        with self.assertRaises(HTTPError) as error:
            self.request("/api/agents/tool", {"name": "list_sessions"})
        self.assertEqual(error.exception.code, 404)

    def test_real_stdio_mcp_to_http_to_browser_mailbox(self):
        rid = self.request("/api/agents/requests", {"session_id": "tab", "context": context(), "prompt": "Inspect U1"})["request_id"]
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_request", "arguments": {"request_id": rid}}},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "publish_feedback", "arguments": feedback(rid)}}]
        process = subprocess.run([sys.executable, "-m", "copper_review.agent_mcp"],
                                 input="\n".join(json.dumps(m) for m in messages).encode() + b"\n",
                                 capture_output=True, timeout=15, cwd=Path(__file__).resolve().parents[1],
                                 env={**os.environ, "COPPER_REVIEW_URL": self.url + "/#token=test-token"})
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(len(responses), 3)
        self.assertEqual(json.loads(responses[1]["result"]["content"][0]["text"])["context"], context())
        self.assertEqual(json.loads(responses[2]["result"]["content"][0]["text"])["status"], "completed")
        updates = self.request("/api/agents/updates?session_id=tab")
        self.assertEqual(updates[0]["feedback"]["payload"]["agent"], "Test reviewer")


if __name__ == "__main__":
    unittest.main()

import json
import unittest

from copper_review.agents import AgentBridge
from copper_review.agent_mcp import Protocol, SELECTION_URI, call_tool
from test_agents import context


class HostChatTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AgentBridge()
        self.bridge.context("tab", context())
        self.protocol = Protocol(lambda name, args: call_tool(self.bridge, name, args))
        result = self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}})
        self.assertEqual(result["result"]["capabilities"]["resources"], {"subscribe": True})
        self.assertIn("prompts", result["result"]["capabilities"])
        self.protocol.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def rpc(self, method, params=None):
        return self.protocol.handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    def tool(self, name, arguments=None):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})["result"]
        if result.get("isError"):
            raise ValueError(result["content"][0]["text"])
        return json.loads(result["content"][0]["text"])

    def test_chat_reads_context_without_enqueuing_or_claiming(self):
        selection = self.tool("get_current_selection")
        self.assertEqual(selection["context"], context())
        self.assertEqual(selection["session_id"], "tab")
        self.assertEqual(self.bridge.requests, {})
        self.assertEqual(self.bridge.workers, {})
        selection["context"]["documents"].clear()
        self.assertEqual(self.bridge.get_context("tab"), context())

    def test_multiple_tabs_require_explicit_selection_and_do_not_fall_back_from_idle_tab(self):
        self.bridge.context("second", context("b" * 64))
        with self.assertRaisesRegex(ValueError, "Several"):
            self.tool("get_current_selection")
        self.tool("select_session", {"session_id": "second"})
        self.assertEqual(self.tool("get_current_selection")["session_id"], "second")
        resource = self.rpc("resources/read", {"uri": SELECTION_URI})
        self.assertEqual(json.loads(resource["result"]["contents"][0]["text"])["session_id"], "second")
        self.assertEqual(self.tool("get_current_selection", {"session_id": "tab"})["session_id"], "tab")
        self.bridge.detach("second")
        with self.assertRaisesRegex(ValueError, "idle"):
            self.tool("get_current_selection")

    def test_navigation_checks_hash_entities_and_browser_ack(self):
        selection = {"components": ["U1"], "nets": [], "region": None}
        args = {"target": "layout", "sha256": "a" * 64, "selection": selection}
        command = self.tool("show_on_board", args)
        self.assertEqual(command["status"], "queued")
        self.assertEqual(self.bridge.get_context("tab"), context())
        self.bridge.context("tab", context())  # Context synchronization must not drop commands.
        self.assertEqual(self.bridge.navigation("tab")["command_id"], command["command_id"])
        self.bridge.acknowledge_navigation("tab", command["command_id"], "applied")
        result = self.tool("get_navigation_status", {"session_id": "tab", "command_id": command["command_id"]})
        self.assertEqual(result["status"], "applied")
        self.bridge.acknowledge_navigation("tab", command["command_id"], "rejected", "Late duplicate")
        self.assertEqual(self.bridge.navigation("tab")["status"], "applied")
        for invalid in [{**args, "sha256": "b" * 64}, {**args, "selection": {**selection, "components": ["unknown"]}}]:
            with self.assertRaises(ValueError):
                self.tool("show_on_board", invalid)

    def test_navigation_is_bounded_expires_and_supports_electrical(self):
        args = {"target": "layout", "sha256": "a" * 64, "selection": context()["documents"]["layout"]["selection"]}
        old = self.tool("show_on_board", args)
        current = self.tool("show_on_board", args)
        with self.assertRaisesRegex(ValueError, "superseded"):
            self.bridge.navigation("tab", old["command_id"])
        self.bridge.sessions["tab"]["navigation_until"] = 0
        self.assertEqual(self.bridge.navigation("tab")["status"], "expired")
        self.bridge.context("tab", {"schema": "copper-review-agent-context/v1", "documents": {
            "electrical": {"sha256": "e" * 64, "entities": {"net": ["DATA"]}}}})
        command = self.tool("show_on_board", {"target": "electrical", "sha256": "e" * 64, "selection": {"kind": "net", "id": "DATA"}})
        self.assertEqual(command["selection"]["id"], "DATA")
        self.bridge.acknowledge_navigation("tab", command["command_id"], "rejected", "Design changed before navigation")
        self.assertEqual(self.bridge.navigation("tab")["status"], "rejected")

    def test_subscriptions_send_only_revision_changes_and_stop_on_unsubscribe(self):
        uri = {"uri": SELECTION_URI}
        self.assertEqual(self.rpc("resources/list")["result"]["resources"][0]["uri"], SELECTION_URI)
        self.rpc("resources/subscribe", uri)
        notifications = []
        for _ in range(3):
            self.bridge.updates("tab")
            self.protocol.poll_notifications(notifications.append)
        self.assertEqual(notifications, [])
        self.bridge.context("tab", context("b" * 64))
        self.protocol.poll_notifications(notifications.append)
        self.protocol.poll_notifications(notifications.append)
        self.assertEqual(notifications, [{"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": uri}])
        self.bridge.detach("tab")
        self.protocol.poll_notifications(notifications.append)
        self.assertEqual(len(notifications), 2)  # Availability changes are visible too.
        self.rpc("resources/unsubscribe", uri)
        self.bridge.context("tab", context())
        self.protocol.poll_notifications(notifications.append)
        self.assertEqual(len(notifications), 2)
        self.assertIn("error", self.rpc("resources/read", {"uri": "file:///secret"}))

    def test_subscriptions_poll_metadata_only(self):
        calls = []
        def call(name, args):
            calls.append(name)
            return call_tool(self.bridge, name, args)
        self.protocol.call = call
        self.rpc("resources/subscribe", {"uri": SELECTION_URI})
        self.bridge.context("tab", context("b" * 64))
        self.protocol.poll_notifications(lambda notification: None)
        self.assertEqual(calls, ["list_sessions", "list_sessions"])

    def test_prompts_are_user_invoked_and_do_not_start_work(self):
        prompts = self.rpc("prompts/list")["result"]["prompts"]
        self.assertEqual({p["name"] for p in prompts}, {"explain-selection", "answer-viewer-questions"})
        direct = self.rpc("prompts/get", {"name": "explain-selection", "arguments": {"question": "What feeds U1?"}})
        text = direct["result"]["messages"][0]["content"]["text"]
        self.assertIn("get_current_selection", text)
        self.assertIn("What feeds U1?", text)
        fallback = self.rpc("prompts/get", {"name": "answer-viewer-questions"})["result"]["messages"][0]["content"]["text"]
        self.assertIn("claim_id", fallback)
        self.assertIn("cannot wake the host", fallback)
        self.assertEqual(self.bridge.requests, {})
        self.assertEqual(self.bridge.workers, {})
        for params in [{"name": "missing"}, {"name": "explain-selection", "arguments": {"question": 1}},
                       {"name": "answer-viewer-questions", "arguments": {"unknown": "x"}}]:
            self.assertIn("error", self.rpc("prompts/get", params))

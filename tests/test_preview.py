import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from copper_review.preview import LivePreview
from copper_review.__main__ import project_files, project_file, make_handler
from copper_review.agents import AgentBridge
from copper_review.agent_mcp import call_tool
from test_agents import context
import test_agents


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "board.copper"
        self.source.write_text("board Test {}")
        self.pcb = self.root / "board.kicad_pcb"
        self.pcb.write_bytes(Path("examples/demo.kicad_pcb").read_bytes())
        self.preview = LivePreview(self.root, "board.copper", self.pcb, listing=project_files, resolve=project_file)
        self.clock = patch("copper_review.preview.time.monotonic", return_value=0).start()
        self.addCleanup(patch.stopall)

    def advance(self):
        self.clock.return_value += 1
        return self.preview.status()

    def ready(self):
        self.preview.status()
        return self.advance()

    def test_debounce_immutable_snapshot_and_exact_hashes(self):
        self.assertEqual(self.preview.status()["source"]["state"], "settling")
        status = self.advance()
        old = status["source"]["revision"]
        snapshot = self.preview.snapshot("source", old)
        self.assertEqual(snapshot["data"]["files"]["board.copper"], "board Test {}")
        self.assertEqual(status["source"]["files"]["board.copper"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.source.write_text("board Changed {}")
        self.assertEqual(self.advance()["source"]["state"], "settling")
        with self.assertRaises(ValueError):
            self.preview.snapshot("source", old)
        new = self.advance()
        self.assertNotEqual(new["source"]["revision"], old)
        self.assertEqual(snapshot["data"]["files"]["board.copper"], "board Test {}")
        self.assertEqual(new["layout"]["revision"], status["layout"]["revision"])

    def test_changed_during_read_is_not_published(self):
        self.preview.status()
        original = self.preview.read
        def changing(kind, signature):
            result = original(kind, signature)
            if kind == "source":
                self.source.write_text("board Newer {}")
            return result
        with patch.object(self.preview, "read", side_effect=changing):
            self.assertEqual(self.advance()["source"]["state"], "settling")
        self.advance()
        status = self.advance()
        self.assertEqual(self.preview.snapshot("source", status["source"]["revision"])["data"]["files"]["board.copper"], "board Newer {}")

    def test_partial_pcb_keeps_last_snapshot_and_recovers(self):
        old = self.ready()["layout"]["revision"]
        good = self.pcb.read_bytes()
        self.pcb.write_bytes(b"(kicad_pcb (version")
        self.advance()
        with patch.object(self.preview, "read", wraps=self.preview.read) as read:
            self.assertEqual(self.advance()["layout"]["state"], "error")
            self.advance()
            self.assertEqual(read.call_count, 1)
        self.assertEqual(self.preview.channels["layout"]["revision"], old)
        self.pcb.write_bytes(good + b"\n")
        self.advance()
        self.assertEqual(self.advance()["layout"]["state"], "ready")

    def test_snapshot_is_bounded_and_non_sources_are_not_served(self):
        (self.root / "private.txt").write_text("secret")
        status = self.ready()
        self.assertNotIn("private.txt", self.preview.snapshot("source", status["source"]["revision"])["data"]["files"])
        with patch("copper_review.preview.MAX_SNAPSHOT", 1):
            self.assertEqual(self.advance()["source"]["state"], "error")

    def test_temporary_inventory_failure_recovers_without_a_source_edit(self):
        old = self.ready()["source"]["revision"]
        with patch.object(self.preview, "inventory", side_effect=OSError("Temporarily unavailable")):
            self.assertEqual(self.advance()["source"]["state"], "error")
        self.advance()
        self.assertEqual(self.advance()["source"]["revision"], old)
        self.assertEqual(self.preview.status()["source"]["state"], "ready")

    def test_tool_distinguishes_disk_from_displayed_revision(self):
        disk = self.ready()
        bridge = AgentBridge()
        bridge.preview_source = self.preview.status
        bridge.context("tab", context())
        self.assertFalse(call_tool(bridge, "get_preview_status", {})["current"]["source"])
        bridge.report_preview("tab", {"layout": {"state": "current", "revision": disk["layout"]["revision"], "sha256": "a" * 64}})
        self.assertTrue(bridge.preview_status()["current"]["layout"])
        self.pcb.write_bytes(self.pcb.read_bytes() + b"\n")
        self.advance()
        self.assertFalse(bridge.current_selection()["preview"]["current"]["layout"])
        with self.assertRaises(ValueError):
            bridge.report_preview("tab", {"layout": {"state": "anything"}})


class PreviewHTTPTests(unittest.TestCase):
    setUp = test_agents.AgentHTTPTests.setUp
    tearDown = test_agents.AgentHTTPTests.tearDown
    request = test_agents.AgentHTTPTests.request

    def test_watch_is_opt_in_and_snapshots_require_browser_token(self):
        self.assertEqual(self.request("/api/preview"), {"enabled": False})
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "board.copper").write_text("board Test {}")
            self.server.RequestHandlerClass = make_handler(None, "test-token", project=directory, watch=True, agents=True, agent_token="agent")
            with patch("copper_review.preview.time.monotonic", return_value=1) as clock:
                self.request("/api/preview")
                clock.return_value = 2
                revision = self.request("/api/preview")["source"]["revision"]
                path = "/api/preview/snapshot?kind=source&revision=" + revision
                self.assertIn("board.copper", self.request(path)["data"]["files"])
                with self.assertRaises(HTTPError) as error:
                    self.request("/api/preview/snapshot?kind=enabled&revision=x")
                self.assertEqual(error.exception.code, 409)
                for endpoint in ["/api/preview", path]:
                    with self.assertRaises(HTTPError) as error:
                        self.request(endpoint, **{"X-Copper-Token": "agent"})
                    self.assertEqual(error.exception.code, 403)

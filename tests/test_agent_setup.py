import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid
import zipfile

from copper_review.agent_setup import setup_config, extension_bundle
from copper_review.agents import AgentBridge
from copper_review import __version__
from copper_review.__main__ import make_handler
import test_agents
from test_agents import context


class ConnectionStateTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AgentBridge()
        self.bridge.context("tab", context())
        self.client = {"id": str(uuid.uuid4()), "name": "Example host"}

    def test_version_warning_is_visible_in_browser_status(self):
        self.bridge.client_activity({**self.client, "version": "old"})
        status = self.bridge.agent_status("tab")["connections"][0]
        self.assertEqual(status["adapter_version"], "old")
        self.assertEqual(status["viewer_version"], __version__)
        self.assertIn("reinstall the extension", status["warnings"][0])
        self.bridge.client_activity({**self.client, "version": __version__})
        self.assertEqual(self.bridge.agent_status("tab")["connections"][0]["warnings"], [])

    def test_heartbeat_does_not_count_as_a_read_and_stale_reads_are_visible(self):
        self.bridge.client_activity(self.client)
        status = self.bridge.agent_status("tab")["connections"][0]
        self.assertTrue(status["connected"])
        self.assertFalse(status["read_current"])
        self.bridge.client_activity(self.client, self.bridge.current_selection("tab"))
        self.assertTrue(self.bridge.agent_status("tab")["connections"][0]["read_current"])
        self.bridge.context("tab", context("b" * 64))
        self.assertFalse(self.bridge.agent_status("tab")["connections"][0]["read_current"])
        self.bridge.clients[self.client["id"]]["seen"] -= 16
        self.assertFalse(self.bridge.agent_status("tab")["connections"][0]["connected"])

    def test_test_requires_a_fresh_read_of_the_same_tab_and_revision(self):
        self.bridge.client_activity(self.client, self.bridge.current_selection("tab"))
        prompt = self.bridge.connection_test("tab")["prompt"]
        self.assertIn('"tab"', prompt)
        self.bridge.client_activity(self.client)
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"]["status"], "waiting")
        self.bridge.context("other", context())
        self.bridge.client_activity(self.client, self.bridge.current_selection("other"))
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"]["status"], "waiting")
        self.bridge.client_activity(self.client, self.bridge.current_selection("tab"))
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"], {"status": "passed", "host": "Example host"})
        self.bridge.context("tab", context("c" * 64))
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"]["status"], "selection_changed")
        self.bridge.context("tab", context())
        self.bridge.connection_test("tab")
        old = self.bridge.current_selection("tab")
        self.bridge.context("tab", context("b" * 64))
        self.bridge.client_activity(self.client, old)
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"]["status"], "selection_changed")
        self.bridge.connection_test("tab")
        self.bridge.sessions["tab"]["connection_test"]["until"] = time.monotonic() - 1
        self.bridge.client_activity(self.client, self.bridge.current_selection("tab"))
        self.assertEqual(self.bridge.agent_status("tab")["connection_test"]["status"], "expired")

    def test_connections_and_read_records_are_bounded(self):
        selected = self.bridge.current_selection("tab")
        for i in range(20):
            self.bridge.client_activity({"id": str(uuid.uuid4()), "name": str(i)}, selected)
        self.assertEqual(len(self.bridge.clients), 16)
        self.assertEqual(len(self.bridge.sessions["tab"]["client_reads"]), 16)


class SetupTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows PowerShell shim regression")
    def test_generated_command_preserves_separator_through_powershell_shim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / "capture.py"
            capture.write_text("import json, sys; print(json.dumps(sys.argv[1:]))")
            quote = lambda s: "'" + str(s).replace("'", "''") + "'"
            (root / "claude.ps1").write_text(f"& {quote(sys.executable)} {quote(capture)} @args")
            with patch("copper_review.agent_setup.sys.executable", str(root / "Tool's Folder" / "$secret" / "python.exe")):
                config = setup_config()
            script = root / "install.ps1"
            script.write_text(config["claude_command"], encoding="utf-8")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                                    env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                                    capture_output=True, text=True, timeout=20, check=True)
            arguments = json.loads(result.stdout)
            separator = arguments.index("--")
            self.assertEqual(arguments[separator + 1:], [config["config"]["command"], *config["config"]["args"]])
            self.assertIn("COPPER_REVIEW_URL=", arguments)

    def test_generated_json_and_toml_use_the_current_runtime(self):
        config = setup_config()
        self.assertTrue(config["runtime_available"])
        self.assertEqual(json.loads(config["claude_json"])["mcpServers"]["copper-review"], config["config"])
        self.assertEqual(tomllib.loads(config["codex_toml"])["mcp_servers"]["copper-review"], config["config"])
        self.assertEqual(config["config"]["command"], str(Path(sys.executable).resolve()))
        self.assertEqual(config["config"]["args"][0], "-I")
        self.assertNotIn("token=", json.dumps(config))

    def test_config_quotes_paths_and_does_not_copy_credentials(self):
        with patch("copper_review.agent_setup.sys.executable", "C:/Tool's Folder/$secret/python.exe"), patch.dict(os.environ, {"COPPER_REVIEW_URL": "http://127.0.0.1:1/#token=secret"}):
            config = setup_config()
        self.assertNotIn("token=secret", json.dumps(config))
        self.assertEqual(tomllib.loads(config["codex_toml"])["mcp_servers"]["copper-review"], config["config"])
        if os.name == "nt":
            self.assertIn("Tool''s Folder", config["claude_command"])


class SetupHTTPTests(unittest.TestCase):
    setUp = test_agents.AgentHTTPTests.setUp
    tearDown = test_agents.AgentHTTPTests.tearDown
    request = test_agents.AgentHTTPTests.request

    def test_version_warning_reaches_the_agent_and_browser(self):
        self.request("/api/agents/context", {"session_id": "tab", "context": context()})
        selected = self.request("/api/agents/tool", {"name": "get_current_selection", "arguments": {},
            "client": {"id": str(uuid.uuid4()), "name": "Older extension", "version": "old"}},
            **{"X-Copper-Token": self.server.RequestHandlerClass.agent_token})
        self.assertEqual(selected["connection"]["adapter_version"], "old")
        warning = selected["connection"]["warnings"][0]
        self.assertIn("reinstall the extension", warning)
        status = self.request("/api/agents/status?session_id=tab")
        self.assertEqual(status["connections"][0]["warnings"], [warning])

    def run_adapter(self, config, cwd):
        self.request("/api/agents/context", {"session_id": "tab", "context": context()})
        self.request("/api/agents/connection-test", {"session_id": "tab"})
        messages = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "clientInfo": {"name": "Packaged host"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_current_selection", "arguments": {"session_id": "tab"}}}]
        result = subprocess.run([config["command"], *config["args"]], cwd=cwd,
            input="\n".join(json.dumps(m) for m in messages).encode() + b"\n", capture_output=True, timeout=15,
            env={**os.environ, **config.get("env", {}), "COPPER_REVIEW_URL": self.url + "/#token=" + self.server.RequestHandlerClass.agent_token})
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertNotIn("isError", responses[-1]["result"])
        selected = json.loads(responses[-1]["result"]["content"][0]["text"])
        self.assertEqual(selected["context"], context())
        status = self.request("/api/agents/status?session_id=tab")
        self.assertEqual(status["connection_test"], {"status": "passed", "host": "Packaged host"})

    def test_generated_launcher_works_from_an_unrelated_directory(self):
        config = self.request("/api/agents/setup")["config"]
        with tempfile.TemporaryDirectory() as directory:
            self.run_adapter(config, directory)

    def test_downloaded_bundle_is_self_contained_and_works_after_extraction(self):
        with urlopen(Request(self.url + "/api/agents/extension", headers={"X-Copper-Token": "test-token"})) as response:
            archive = zipfile.ZipFile(io.BytesIO(response.read()))
        expected = {"manifest.json", "README.txt", *("copper_review/" + n for n in ("__init__.py", "agent_stdio.py", "agent_mcp.py", "agent_discovery.py"))}
        self.assertEqual(set(archive.namelist()), expected)
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["manifest_version"], "0.3")
        self.assertNotIn("test-token", json.dumps(manifest))
        with tempfile.TemporaryDirectory(prefix="CopperReview extension ") as directory:
            archive.extractall(directory)  # Exact allowlisted names checked above.
            config = manifest["server"]["mcp_config"]
            config["command"] = manifest["user_config"]["python_path"]["default"]
            config["args"] = [arg.replace("${__dirname}", directory) for arg in config["args"]]
            self.run_adapter(config, tempfile.gettempdir())

    def test_setup_and_test_actions_require_browser_credentials(self):
        agent = {"X-Copper-Token": self.server.RequestHandlerClass.agent_token}
        for path, body in [("/api/agents/setup", None), ("/api/agents/extension", None),
                           ("/api/agents/connection-test", {"session_id": "tab"})]:
            with self.assertRaises(HTTPError) as error:
                self.request(path, body, **agent)
            self.assertEqual(error.exception.code, 403)
        self.server.RequestHandlerClass = make_handler(None, "test-token")
        with self.assertRaises(HTTPError) as error:
            self.request("/api/agents/setup")
        self.assertEqual(error.exception.code, 404)

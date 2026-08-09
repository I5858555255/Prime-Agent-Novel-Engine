from __future__ import annotations

import asyncio
import json
import os
import selectors
import shutil
import subprocess
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest import mock

import context_mode
from rlm import McpIntegration, mcp_base


SUPPORTED_LANGUAGES = frozenset(
    {
        "javascript",
        "typescript",
        "python",
        "shell",
        "ruby",
        "go",
        "rust",
        "php",
        "perl",
        "r",
        "elixir",
        "csharp",
    }
)
EXAMPLE_PATH = "logs/server.log"
EXAMPLE_LANGUAGE = "python"
EXAMPLE_CODE = (
    "errors=[l for l in FILE_CONTENT.splitlines() if 'ERROR' in l]; "
    "print(len(errors)); print('\\n'.join(errors[:10]))"
)
EXAMPLE_INTENT = "Find the first recurring production failure."


def run(coro):
    return asyncio.run(coro)


class FakeSession:
    def __init__(self):
        self.calls = []

    async def list_tools(self):
        tools = []
        for name in ("ctx_execute_file", "ctx_purge"):
            tool = type("Tool", (), {})()
            tool.name = name
            tool.description = name
            tool.inputSchema = {"type": "object"}
            tools.append(tool)
        response = type("Response", (), {})()
        response.tools = tools
        return response

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return type("Result", (), {"structuredContent": {"ok": True}, "content": []})()


def _stdio_request(process, request_id, method, params, timeout=10.0):
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(
        json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        + "\n"
    )
    process.stdin.flush()

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise AssertionError(f"timed out waiting for stdio response {request_id}")
            line = process.stdout.readline()
            if not line:
                raise AssertionError("Context Mode stdio server closed stdout")
            response = json.loads(line)
            if response.get("id") == request_id:
                return response
    finally:
        selector.close()


class ContextModeTest(unittest.TestCase):
    def test_import_and_diagnostic_do_not_install_or_start_a_sidecar(self):
        integration = context_mode.ContextMode()
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ), mock.patch.object(context_mode.shutil, "which", return_value=None) as which:
            diagnostic = run(integration.available())
        self.assertFalse(diagnostic["configured"])
        which.assert_called_once_with("context-mode")

    def test_host_stdio_setup_is_configured_without_exposing_process_settings(self):
        integration = context_mode.ContextMode()
        config = {
            "type": "stdio",
            "bridge": "host",
            "command": "secret-context-mode",
            "env": {"TOKEN": "secret"},
        }
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value=config)
        ), mock.patch.object(context_mode.shutil, "which", return_value=None):
            diagnostic = run(integration.available())
        self.assertTrue(diagnostic["configured"])
        self.assertEqual(diagnostic["transport"], "stdio")
        self.assertIsNone(diagnostic["endpoint"])
        self.assertIsNone(diagnostic["executable"])
        self.assertFalse(diagnostic["stdio_only"])
        self.assertNotIn("command", diagnostic)
        self.assertNotIn("env", diagnostic)
        self.assertNotIn("secret", repr(diagnostic))

    def test_stdio_only_setup_has_actionable_error(self):
        integration = context_mode.ContextMode()
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ), mock.patch.object(context_mode.shutil, "which", return_value="/usr/bin/context-mode"):
            with self.assertRaisesRegex(context_mode.SidecarUnavailable, "local command"):
                run(integration._open_session(AsyncExitStack()))

    def test_disabled_config_is_unavailable_before_creating_a_transport(self):
        integration = context_mode.ContextMode()
        transport = mock.MagicMock()
        with mock.patch.object(
            McpIntegration,
            "_resolve_host_config",
            new=mock.AsyncMock(side_effect=mcp_base.Disabled("context-mode")),
        ), mock.patch.object(context_mode.mcp_base, "_resolve_streamable_http", return_value=transport):
            diagnostic = run(integration.available())
            with self.assertRaisesRegex(context_mode.SidecarUnavailable, "disabled"):
                run(integration._open_session(AsyncExitStack()))
        self.assertFalse(diagnostic["configured"])
        self.assertTrue(diagnostic["disabled"])
        transport.assert_not_called()

    def test_configured_endpoint_forwards_allowed_tool_and_hides_disallowed_tools(self):
        integration = context_mode.ContextMode()
        session = FakeSession()

        async def open_session(stack):
            return session

        with mock.patch.object(integration, "_open_session", open_session), \
             mock.patch.object(
                 McpIntegration,
                 "_resolve_host_config",
                 new=mock.AsyncMock(return_value={"url": "https://sidecar.test/mcp"}),
             ):
            diagnostic = run(integration.available())
            tools = run(integration.list_tools())
            result = run(
                integration.ctx_execute_file(
                    path=EXAMPLE_PATH,
                    language=EXAMPLE_LANGUAGE,
                    code=EXAMPLE_CODE,
                    intent=EXAMPLE_INTENT,
                )
            )
        self.assertEqual(diagnostic["endpoint"], "https://sidecar.test/mcp")
        self.assertEqual([tool["name"] for tool in tools], ["ctx_execute_file"])
        self.assertEqual(result, {"ok": True})
        self.assertEqual(
            session.calls,
            [
                (
                    "ctx_execute_file",
                    {
                        "path": EXAMPLE_PATH,
                        "language": EXAMPLE_LANGUAGE,
                        "code": EXAMPLE_CODE,
                        "intent": EXAMPLE_INTENT,
                    },
                )
            ],
        )
        self.assertIn(session.calls[0][1]["language"], SUPPORTED_LANGUAGES)
        self.assertIn("FILE_CONTENT", session.calls[0][1]["code"])

    def test_host_stdio_dispatches_list_and_call_without_opening_http_session(self):
        integration = context_mode.ContextMode()
        calls = []

        async def host_request_bridge(req_type, payload, **kwargs):
            calls.append((req_type, payload))
            if req_type == "mcp.config":
                return {
                    "type": "stdio",
                    "bridge": "host",
                    "command": "secret-context-mode",
                    "env": {"TOKEN": "secret"},
                }
            if req_type == "mcp.list_tools":
                return {
                    "tools": [
                        {"name": "ctx_execute_file", "description": "Execute", "inputSchema": {}},
                        {"name": "ctx_index", "description": "Index", "inputSchema": {}},
                        {"name": "ctx_purge", "description": "Maintenance", "inputSchema": {}},
                    ]
                }
            if req_type == "mcp.call_tool":
                return {"result": {"structuredContent": {"ok": payload["arguments"]}, "content": []}}
            raise AssertionError(req_type)

        with (
            mock.patch.object(context_mode.mcp_base, "host_request", host_request_bridge),
            mock.patch.object(integration, "_open_session", side_effect=AssertionError("HTTP session opened")),
        ):
            tools = run(integration.list_tools())
            result = run(
                integration.ctx_execute_file(
                    path=EXAMPLE_PATH,
                    language=EXAMPLE_LANGUAGE,
                    code=EXAMPLE_CODE,
                    intent=EXAMPLE_INTENT,
                )
            )
            indexed = run(integration.call_tool("ctx_index", {"content": "adapter", "source": "test"}))

        self.assertEqual([tool["name"] for tool in tools], ["ctx_execute_file", "ctx_index"])
        self.assertEqual(
            result,
            {
                "ok": {
                    "path": EXAMPLE_PATH,
                    "language": EXAMPLE_LANGUAGE,
                    "code": EXAMPLE_CODE,
                    "intent": EXAMPLE_INTENT,
                }
            },
        )
        example_call = next(
            payload["arguments"]
            for req_type, payload in calls
            if req_type == "mcp.call_tool" and payload.get("tool") == "ctx_execute_file"
        )
        self.assertIn(example_call["language"], SUPPORTED_LANGUAGES)
        self.assertIn("FILE_CONTENT", example_call["code"])
        self.assertEqual(indexed, {"ok": {"content": "adapter", "source": "test"}})
        self.assertIn("mcp.list_tools", [req_type for req_type, _ in calls])
        self.assertIn("mcp.call_tool", [req_type for req_type, _ in calls])

    def test_skill_example_executes_against_real_stdio_sidecar(self):
        executable = shutil.which("context-mode")
        if executable is None:
            self.skipTest("context-mode executable is not installed")

        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            log_path = workspace / EXAMPLE_PATH
            log_path.parent.mkdir(parents=True)
            log_path.write_text("INFO one\nERROR first\nERROR second\n")
            env = os.environ.copy()
            env["CONTEXT_MODE_DIR"] = str(workspace / ".context-mode")
            env["CONTEXT_MODE_PROJECT_DIR"] = str(workspace)
            env["CLAUDE_PROJECT_DIR"] = str(workspace)
            env["PWD"] = str(workspace)
            process = subprocess.Popen(
                [executable],
                cwd=workspace,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            try:
                initialized = _stdio_request(
                    process,
                    1,
                    "initialize",
                    {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "context-mode-skill-test", "version": "1"},
                    },
                )
                self.assertIn("result", initialized)
                self.assertIn("tools", initialized["result"]["capabilities"])
                assert process.stdin is not None
                process.stdin.write(
                    json.dumps(
                        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
                    )
                    + "\n"
                )
                process.stdin.flush()
                response = _stdio_request(
                    process,
                    2,
                    "tools/call",
                    {
                        "name": "ctx_execute_file",
                        "arguments": {
                            "path": EXAMPLE_PATH,
                            "language": EXAMPLE_LANGUAGE,
                            "code": EXAMPLE_CODE,
                            "intent": EXAMPLE_INTENT,
                        },
                    },
                )
                self.assertNotIn("error", response)
                text = response["result"]["content"][0]["text"]
                self.assertIn("2", text)
                self.assertIn("ERROR first", text)
                self.assertIn("ERROR second", text)
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                if process.stdin is not None:
                    process.stdin.close()
                if process.stdout is not None:
                    process.stdout.close()

    def test_maintenance_tools_are_blocked_even_when_server_advertises_them(self):
        integration = context_mode.ContextMode()
        session = FakeSession()

        async def open_session(stack):
            return session

        with mock.patch.object(integration, "_open_session", open_session):
            with self.assertRaisesRegex(PermissionError, "disabled"):
                run(integration.call_tool("ctx_purge", {}))
            with self.assertRaisesRegex(PermissionError, "disabled"):
                run(integration.ctx_purge())
        with self.assertRaisesRegex(PermissionError, "disabled"):
            run(integration.call_tool("ctx_upgrade", {}))


if __name__ == "__main__":
    unittest.main()

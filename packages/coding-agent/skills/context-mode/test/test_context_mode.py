from __future__ import annotations

import asyncio
import unittest
from contextlib import AsyncExitStack
from unittest import mock

import context_mode
from rlm import McpIntegration, mcp_base


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
            result = run(integration.ctx_execute_file(path="large.log", language="text", code="Summarize."))
        self.assertEqual(diagnostic["endpoint"], "https://sidecar.test/mcp")
        self.assertEqual([tool["name"] for tool in tools], ["ctx_execute_file"])
        self.assertEqual(result, {"ok": True})
        self.assertEqual(session.calls, [("ctx_execute_file", {"path": "large.log", "language": "text", "code": "Summarize."})])

    def test_host_stdio_dispatches_list_and_call_without_opening_http_session(self):
        integration = context_mode.ContextMode()
        calls = []

        async def host_request_bridge(req_type, payload):
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
            result = run(integration.ctx_execute_file(path="large.log", language="text", code="Summarize."))
            indexed = run(integration.call_tool("ctx_index", {"content": "adapter", "source": "test"}))

        self.assertEqual([tool["name"] for tool in tools], ["ctx_execute_file", "ctx_index"])
        self.assertEqual(result, {"ok": {"path": "large.log", "language": "text", "code": "Summarize."}})
        self.assertEqual(indexed, {"ok": {"content": "adapter", "source": "test"}})
        self.assertIn("mcp.list_tools", [req_type for req_type, _ in calls])
        self.assertIn("mcp.call_tool", [req_type for req_type, _ in calls])

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

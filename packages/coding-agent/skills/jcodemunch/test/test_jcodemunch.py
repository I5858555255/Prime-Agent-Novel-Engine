from __future__ import annotations

import asyncio
import unittest
from contextlib import AsyncExitStack
from unittest import mock

import jcodemunch
from rlm import McpIntegration, mcp_base


def run(coro):
    return asyncio.run(coro)


class FakeSession:
    def __init__(self):
        self.calls = []

    async def list_tools(self):
        tool = type("Tool", (), {})()
        tool.name = "search_symbols"
        tool.description = "Search"
        tool.inputSchema = {"type": "object"}
        response = type("Response", (), {})()
        response.tools = [tool]
        return response

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return type("Result", (), {"structuredContent": {"ok": True}, "content": []})()


class JCodeMunchTest(unittest.TestCase):
    def test_import_and_diagnostic_do_not_install_or_start_a_sidecar(self):
        integration = jcodemunch.JCodeMunch()
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ), mock.patch.object(jcodemunch.shutil, "which", return_value=None) as which:
            diagnostic = run(integration.available())
        self.assertFalse(diagnostic["configured"])
        self.assertIsNone(diagnostic["executable"])
        which.assert_called_once_with("jcodemunch-mcp")

    def test_host_stdio_setup_is_configured_without_exposing_process_settings(self):
        integration = jcodemunch.JCodeMunch()
        config = {
            "type": "stdio",
            "bridge": "host",
            "command": "secret-jcodemunch",
            "env": {"TOKEN": "secret"},
        }
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value=config)
        ), mock.patch.object(jcodemunch.shutil, "which", return_value=None):
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
        integration = jcodemunch.JCodeMunch()
        with mock.patch.object(
            McpIntegration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ), mock.patch.object(jcodemunch.shutil, "which", return_value="/usr/bin/jcodemunch-mcp"):
            with self.assertRaisesRegex(jcodemunch.SidecarUnavailable, "local command"):
                run(integration._open_session(AsyncExitStack()))

    def test_disabled_config_is_unavailable_before_creating_a_transport(self):
        integration = jcodemunch.JCodeMunch()
        transport = mock.MagicMock()
        with mock.patch.object(
            McpIntegration,
            "_resolve_host_config",
            new=mock.AsyncMock(side_effect=mcp_base.Disabled("jcodemunch")),
        ), mock.patch.object(jcodemunch.mcp_base, "_resolve_streamable_http", return_value=transport):
            diagnostic = run(integration.available())
            with self.assertRaisesRegex(jcodemunch.SidecarUnavailable, "disabled"):
                run(integration._open_session(AsyncExitStack()))
        self.assertFalse(diagnostic["configured"])
        self.assertTrue(diagnostic["disabled"])
        transport.assert_not_called()

    def test_configured_endpoint_forwards_supported_tool_and_arguments(self):
        integration = jcodemunch.JCodeMunch()
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
            self.assertEqual(run(integration.search_symbols(repo="demo", query="Thing")), {"ok": True})
        self.assertEqual(diagnostic["endpoint"], "https://sidecar.test/mcp")
        self.assertEqual(session.calls, [("search_symbols", {"repo": "demo", "query": "Thing"})])

    def test_host_stdio_dispatches_list_and_call_without_opening_http_session(self):
        integration = jcodemunch.JCodeMunch()
        calls = []

        async def host_request_bridge(req_type, payload):
            calls.append((req_type, payload))
            if req_type == "mcp.config":
                return {
                    "type": "stdio",
                    "bridge": "host",
                    "command": "secret-jcodemunch",
                    "env": {"TOKEN": "secret"},
                }
            if req_type == "mcp.list_tools":
                return {
                    "tools": [
                        {"name": "search_symbols", "description": "Search", "inputSchema": {}},
                        {"name": "plan_turn", "description": "Plan", "inputSchema": {}},
                        {"name": "assemble_task_context", "description": "Context", "inputSchema": {}},
                        {"name": "upgrade", "description": "Maintenance", "inputSchema": {}},
                        {"name": "purge", "description": "Maintenance", "inputSchema": {}},
                        {"name": "not_exposed", "description": "Other", "inputSchema": {}},
                    ]
                }
            if req_type == "mcp.call_tool":
                return {"result": {"structuredContent": {"ok": payload["arguments"]}, "content": []}}
            raise AssertionError(req_type)

        with (
            mock.patch.object(jcodemunch.mcp_base, "host_request", host_request_bridge),
            mock.patch.object(integration, "_open_session", side_effect=AssertionError("HTTP session opened")),
        ):
            tools = run(integration.list_tools())
            result = run(integration.search_symbols(repo="demo", query="Thing"))
            plan = run(integration.call_tool("plan_turn", {"task": "Find the adapter"}))
            context = run(integration.call_tool("assemble_task_context", {"task": "Review it"}))

        self.assertEqual(
            [tool["name"] for tool in tools],
            ["search_symbols", "plan_turn", "assemble_task_context"],
        )
        self.assertEqual(result, {"ok": {"repo": "demo", "query": "Thing"}})
        self.assertEqual(plan, {"ok": {"task": "Find the adapter"}})
        self.assertEqual(context, {"ok": {"task": "Review it"}})
        with self.assertRaisesRegex(AttributeError, "not part of this skill"):
            run(integration.call_tool("upgrade", {}))
        self.assertIn("mcp.list_tools", [req_type for req_type, _ in calls])
        self.assertIn("mcp.call_tool", [req_type for req_type, _ in calls])

    def test_unauthenticated_http_endpoint_preserves_static_headers(self):
        integration = jcodemunch.JCodeMunch()
        captured = {}

        class TransportContext:
            async def __aenter__(self):
                return ("read", "write", None)

            async def __aexit__(self, *args):
                return False

        def transport(url, headers=None):
            captured["url"] = url
            captured["headers"] = headers
            return TransportContext()

        with mock.patch.object(
            McpIntegration,
            "_resolve_config",
            new=mock.AsyncMock(return_value=("https://sidecar.test/mcp", {"X-Trace": "1"})),
        ), mock.patch.object(integration, "_resolve_token", new=mock.AsyncMock(return_value=None)), \
             mock.patch.object(jcodemunch.mcp_base, "_resolve_streamable_http", return_value=transport), \
             mock.patch("mcp.ClientSession") as session_class:
            session = mock.MagicMock()
            session.initialize = mock.AsyncMock()
            session_class.return_value.__aenter__ = mock.AsyncMock(return_value=session)
            session_class.return_value.__aexit__ = mock.AsyncMock(return_value=False)
            run(integration._open_session(AsyncExitStack()))
        self.assertEqual(captured, {"url": "https://sidecar.test/mcp", "headers": {"X-Trace": "1"}})

    def test_missing_server_capability_is_actionable(self):
        integration = jcodemunch.JCodeMunch()
        session = FakeSession()

        async def open_session(stack):
            return session

        with mock.patch.object(integration, "_open_session", open_session):
            with self.assertRaisesRegex(AttributeError, "does not provide 'get_file_outline'"):
                run(integration.call_tool("get_file_outline", {"repo": "demo", "file_path": "a.py"}))


if __name__ == "__main__":
    unittest.main()

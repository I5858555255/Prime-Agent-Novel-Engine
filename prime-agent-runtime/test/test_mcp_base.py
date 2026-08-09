from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest import mock

import rlm as rlm_module
from rlm import mcp_base
from rlm.mcp_base import McpIntegration, McpToolError, NotEnabled


def _run(coro):
    return asyncio.run(coro)


class _FakeSession:
    """Stand-in for an mcp ClientSession with canned tools/results."""

    def __init__(self, tools, result):
        self._tools = tools
        self._result = result
        self.calls = []

    async def list_tools(self):
        Tool = type("Tool", (), {})

        def make(name, desc, schema):
            t = Tool()
            t.name = name
            t.description = desc
            t.inputSchema = schema
            return t

        resp = type("Resp", (), {})()
        resp.tools = [make(*t) for t in self._tools]
        return resp

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self._result


class _Integration(McpIntegration):
    server = "demo"
    url = "https://example.test/mcp"


class _FakeComm:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._on_msg = None
        self.close_calls = 0
        self.open_data = None
        type(self).instances.append(self)

    def on_msg(self, callback):
        self._on_msg = callback

    def open(self, data=None):
        self.open_data = data

    def close(self):
        self.close_calls += 1

    def deliver(self, data):
        assert self._on_msg is not None
        self._on_msg({"content": {"data": data}})


class HostRequestTest(unittest.TestCase):
    def setUp(self):
        _FakeComm.instances.clear()

    def test_timeout_uses_env_override_and_closes_comm(self):
        async def exercise():
            with mock.patch.object(rlm_module, "Comm", _FakeComm), mock.patch.dict(
                "os.environ", {"RLM_HOST_REQUEST_TIMEOUT": "0.01"}
            ):
                with self.assertRaisesRegex(TimeoutError, "mcp.timeout"):
                    await rlm_module.host_request("mcp.timeout")

        _run(exercise())
        self.assertEqual(len(_FakeComm.instances), 1)
        self.assertEqual(_FakeComm.instances[0].close_calls, 1)

    def test_cancellation_closes_comm_and_names_request(self):
        async def exercise():
            with mock.patch.object(rlm_module, "Comm", _FakeComm):
                task = asyncio.create_task(rlm_module.host_request("mcp.cancel"))
                await asyncio.sleep(0)
                task.cancel()
                with self.assertRaisesRegex(asyncio.CancelledError, "mcp.cancel"):
                    await task

        _run(exercise())
        self.assertEqual(len(_FakeComm.instances), 1)
        self.assertEqual(_FakeComm.instances[0].close_calls, 1)

    def test_late_reply_after_timeout_is_ignored_and_does_not_reclose(self):
        async def exercise():
            with mock.patch.object(rlm_module, "Comm", _FakeComm):
                with self.assertRaises(TimeoutError):
                    await rlm_module.host_request("mcp.late", timeout=0.01)
                comm = _FakeComm.instances[0]
                comm.deliver({"status": "ok", "value": "late"})
                await asyncio.sleep(0)
                self.assertEqual(comm.close_calls, 1)

        _run(exercise())


class McpIntegrationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.agent_dir = Path(self._tmp.name)
        self.auth_path = self.agent_dir / "auth.json"
        patcher = mock.patch.object(mcp_base, "_agent_dir", return_value=self.agent_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def _write_auth(self, cred):
        self.auth_path.write_text(json.dumps({"mcp:demo": cred}))

    def _patch_session(self, session):
        # Replace _open_session so no real network/SDK is needed.
        async def fake_open(self_, stack: AsyncExitStack):
            return session

        return mock.patch.object(_Integration, "_open_session", fake_open)

    def test_not_enabled_without_credentials(self):
        integration = _Integration()
        with self.assertRaises(NotEnabled):
            _run(integration._resolve_token())

    def test_reads_oauth_access_token(self):
        self._write_auth(
            {"type": "oauth", "access": "tok-123", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        self.assertEqual(_run(_Integration()._resolve_token()), "tok-123")

    def test_reads_api_key(self):
        self._write_auth({"type": "api_key", "key": "key-abc"})
        self.assertEqual(_run(_Integration()._resolve_token()), "key-abc")

    def test_api_key_env_indirection_resolved(self):
        self._write_auth({"type": "api_key", "key": "MY_MCP_KEY"})
        with mock.patch.dict("os.environ", {"MY_MCP_KEY": "resolved-secret"}):
            self.assertEqual(_run(_Integration()._resolve_token()), "resolved-secret")

    def test_refreshes_via_host_when_expired(self):
        self._write_auth(
            {"type": "oauth", "access": "old", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def fake_host_request(req_type, payload, **kwargs):
            self.assertEqual(req_type, "mcp.refresh")
            self.assertEqual(payload, {"server": "demo"})
            # Simulate the host rewriting auth.json with a fresh token.
            self._write_auth(
                {"type": "oauth", "access": "new", "refresh": "r", "expires": (time.time() + 3600) * 1000}
            )
            return {}

        with mock.patch.object(mcp_base, "host_request", fake_host_request):
            self.assertEqual(_run(_Integration()._resolve_token()), "new")

    def test_not_enabled_when_refresh_leaves_token_expired(self):
        # Host refresh "succeeds" but auth.json still holds an expired token →
        # must raise NotEnabled, not return the stale access value.
        self._write_auth(
            {"type": "oauth", "access": "stale", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def fake_host_request(req_type, payload, **kwargs):
            return {}  # no-op: token stays expired

        with mock.patch.object(mcp_base, "host_request", fake_host_request):
            with self.assertRaises(NotEnabled):
                _run(_Integration()._resolve_token())

    def test_refresh_failure_surfaces_as_error_not_not_enabled(self):
        # Creds exist but the host refresh fails transiently → surface a refresh
        # error, not a misleading NotEnabled (which implies re-login).
        self._write_auth(
            {"type": "oauth", "access": "stale", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def failing_host_request(req_type, payload, **kwargs):
            raise RuntimeError("network down")

        with mock.patch.object(mcp_base, "host_request", failing_host_request):
            with self.assertRaises(RuntimeError) as ctx:
                _run(_Integration()._resolve_token())
        self.assertNotIsInstance(ctx.exception, NotEnabled)
        self.assertIn("refresh", str(ctx.exception).lower())

    def test_bearer_token_env_wins(self):
        class EnvIntegration(_Integration):
            bearer_token_env = "DEMO_MCP_TOKEN"

        with mock.patch.dict("os.environ", {"DEMO_MCP_TOKEN": "env-secret"}):
            self.assertEqual(_run(EnvIntegration()._resolve_token()), "env-secret")

    def test_empty_structured_result_preserved(self):
        for payload in ({}, []):
            result = type("R", (), {"structuredContent": payload, "content": [], "isError": False})()
            self.assertEqual(mcp_base._parse_result(result), payload)

    def test_error_result_raises(self):
        block = type("B", (), {"text": "boom"})()
        result = type("R", (), {"isError": True, "content": [block], "structuredContent": None})()
        with self.assertRaises(McpToolError) as ctx:
            mcp_base._parse_result(result)
        self.assertIn("boom", str(ctx.exception))

    def test_auto_bound_tool_calls_session(self):
        session = _FakeSession(
            tools=[("list_issues", "List issues", {"type": "object"})],
            result=type("R", (), {"structuredContent": {"issues": [1, 2]}})(),
        )
        self._write_auth(
            {"type": "oauth", "access": "t", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        with self._patch_session(session), mock.patch.object(
            _Integration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ):
            integration = _Integration()
            out = _run(integration.list_issues(team="Eng"))
        self.assertEqual(out, {"issues": [1, 2]})
        self.assertEqual(session.calls, [("list_issues", {"team": "Eng"})])

    def test_unknown_tool_raises_with_available_list(self):
        session = _FakeSession(tools=[("list_issues", "", {})], result=None)
        self._write_auth(
            {"type": "oauth", "access": "t", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        with self._patch_session(session), mock.patch.object(
            _Integration, "_resolve_host_config", new=mock.AsyncMock(return_value={})
        ):
            integration = _Integration()
            with self.assertRaises(AttributeError) as ctx:
                _run(integration.nonexistent_tool())
        self.assertIn("list_issues", str(ctx.exception))

    def test_text_result_parsing(self):
        block = type("B", (), {"text": "hello"})()
        result = type("R", (), {"content": [block], "structuredContent": None})()
        self.assertEqual(mcp_base._parse_result(result), "hello")

    def test_requires_server_attribute(self):
        class Bad(McpIntegration):
            server = ""

        with self.assertRaises(ValueError):
            Bad()

    def _run_open_session_with_transport(self, transport):
        """Drive the real _open_session against a fake transport callable.

        `transport` must declare its real parameters (headers= or http_client=)
        so the signature inspection in _open_session is exercised faithfully.
        """
        self._write_auth(
            {"type": "oauth", "access": "tok-xyz", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )

        async def fake_host_request(req_type, payload, **kwargs):
            return {}  # no host URL override; _resolve_url falls back to self.url

        with mock.patch.object(mcp_base, "host_request", fake_host_request), \
             mock.patch.object(mcp_base, "_resolve_streamable_http", lambda: transport), \
             mock.patch("mcp.ClientSession") as session_cls:
            session = mock.MagicMock()
            session.initialize = mock.AsyncMock()
            session.call_tool = mock.AsyncMock(
                return_value=type("R", (), {"content": [], "structuredContent": None})()
            )
            session_cls.return_value.__aenter__ = mock.AsyncMock(return_value=session)
            session_cls.return_value.__aexit__ = mock.AsyncMock(return_value=False)
            _run(_Integration().call_tool("noop", {}))

    def test_open_session_uses_headers_signature(self):
        # streamablehttp_client(url, headers=...)
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(transport)
        self.assertEqual(captured["headers"], {"Authorization": "Bearer tok-xyz"})

    def test_open_session_uses_http_client_signature(self):
        # streamable_http_client(url, *, http_client=...) — must NOT pass headers=
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, *, http_client=None):
            captured["http_client"] = http_client
            return _CM()

        self._run_open_session_with_transport(transport)
        self.assertIsNotNone(captured["http_client"])

    def test_resolve_config_denies_an_explicitly_disabled_server(self):
        async def host_disabled(req_type, payload, **kwargs):
            return {"enabled": False}

        with mock.patch.object(mcp_base, "host_request", host_disabled):
            with self.assertRaisesRegex(mcp_base.Disabled, "disabled"):
                _run(_Integration()._resolve_config())

    def test_stdio_bridge_uses_host_process_without_opening_python_sessions(self):
        calls = []

        async def host_request_bridge(req_type, payload, **kwargs):
            calls.append((req_type, payload))
            if req_type == "mcp.config":
                return {"type": "stdio", "bridge": "host"}
            if req_type == "mcp.list_tools":
                return {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {}}]}
            if req_type == "mcp.call_tool":
                return {"result": {"structuredContent": {"ok": payload["arguments"]}, "content": []}}
            raise AssertionError(req_type)

        with mock.patch.object(mcp_base, "host_request", host_request_bridge):
            with mock.patch.object(_Integration, "_open_session", side_effect=AssertionError("HTTP session opened")):
                integration = _Integration()
                self.assertEqual(_run(integration.list_tools()), [{"name": "echo", "description": "Echo", "inputSchema": {}}])
                self.assertEqual(_run(integration.call_tool("echo", {"value": 1})), {"ok": {"value": 1}})
        self.assertEqual(
            [call[0] for call in calls],
            ["mcp.config", "mcp.list_tools", "mcp.config", "mcp.call_tool"],
        )

    def test_host_request_timeout_propagates_through_bridge_calls(self):
        calls = []

        async def host_request_bridge(req_type, payload, **kwargs):
            calls.append((req_type, kwargs.get("timeout")))
            if req_type == "mcp.config":
                return {"type": "stdio", "bridge": "host"}
            if req_type == "mcp.list_tools":
                return {"tools": [{"name": "echo", "description": "", "inputSchema": {}}]}
            if req_type == "mcp.call_tool":
                return {"result": {"structuredContent": {"ok": True}, "content": []}}
            raise AssertionError(req_type)

        with mock.patch.object(mcp_base, "host_request", host_request_bridge):
            integration = _Integration()
            integration.host_request_timeout = 0.25
            self.assertEqual(_run(integration.list_tools())[0]["name"], "echo")
            self.assertEqual(_run(integration.call_tool("echo")), {"ok": True})

        self.assertEqual(
            calls,
            [
                ("mcp.config", 0.25),
                ("mcp.list_tools", 0.25),
                ("mcp.config", 0.25),
                ("mcp.call_tool", 0.25),
            ],
        )

    def test_list_tools_resolves_filter_config_once_for_many_tools(self):
        calls = []

        async def host_request_many_tools(req_type, payload, **kwargs):
            calls.append((req_type, payload))
            if req_type == "mcp.config":
                return {
                    "type": "stdio",
                    "bridge": "host",
                    "enabledTools": ["tool-0", "tool-2"],
                }
            if req_type == "mcp.list_tools":
                return {
                    "tools": [
                        {"name": f"tool-{index}", "description": "", "inputSchema": {}}
                        for index in range(81)
                    ]
                }
            raise AssertionError(req_type)

        with mock.patch.object(mcp_base, "host_request", host_request_many_tools):
            tools = _run(_Integration().list_tools())

        self.assertEqual([tool["name"] for tool in tools], ["tool-0", "tool-2"])
        self.assertEqual([call[0] for call in calls], ["mcp.config", "mcp.list_tools"])

    def test_host_bridge_parses_error_result(self):
        async def host_request_error(req_type, payload, **kwargs):
            if req_type == "mcp.config":
                return {"type": "stdio", "bridge": "host"}
            return {"result": {"isError": True, "content": [{"text": "boom"}]}}

        with mock.patch.object(mcp_base, "host_request", host_request_error):
            with self.assertRaisesRegex(McpToolError, "boom"):
                _run(_Integration().call_tool("echo"))

    def test_resolve_config_prefers_host_override_and_headers(self):
        async def host_with_override(req_type, payload, **kwargs):
            return {"url": "https://override.test/mcp", "headers": {"X-Extra": "1"}}

        async def host_empty(req_type, payload, **kwargs):
            return {}

        with mock.patch.object(mcp_base, "host_request", host_with_override):
            url, headers = _run(_Integration()._resolve_config())
            self.assertEqual(url, "https://override.test/mcp")
            self.assertEqual(headers, {"X-Extra": "1"})
        with mock.patch.object(mcp_base, "host_request", host_empty):
            url, headers = _run(_Integration()._resolve_config())
            self.assertEqual(url, _Integration.url)
            self.assertEqual(headers, {})


    def test_host_tool_allowlists_apply_to_http_integrations(self):
        integration = _Integration()
        integration._tools = {
            "allowed": {"name": "allowed", "description": "", "inputSchema": {}},
            "blocked": {"name": "blocked", "description": "", "inputSchema": {}},
        }

        async def host_config(req_type, payload, **kwargs):
            self.assertEqual(req_type, "mcp.config")
            return {"url": _Integration.url, "enabledTools": ["allowed"]}

        with mock.patch.object(mcp_base, "host_request", host_config):
            self.assertEqual([tool["name"] for tool in _run(integration.list_tools())], ["allowed"])
            with self.assertRaisesRegex(PermissionError, "not allowed"):
                _run(integration.call_tool("blocked"))


if __name__ == "__main__":
    unittest.main()

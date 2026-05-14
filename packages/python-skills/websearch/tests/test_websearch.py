from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

import websearch
from websearch.websearch import (
    _decode_duckduckgo_url,
    _parse_exa_mcp_response,
    _parse_exa_mcp_results,
    _parse_duckduckgo_html,
    cli,
)


SAMPLE_DUCKDUCKGO_HTML = """
<html>
  <body>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpaper">Paper</a>
    <a class="result__snippet">A useful result snippet.</a>
    <a class="result__a" href="https://example.org/docs">Docs &amp; API</a>
    <div class="result__snippet">Reference material.</div>
  </body>
</html>
"""

SAMPLE_EXA_MCP_TEXT = """
Title: Paper
URL: https://example.com/paper
Published: N/A
Author: N/A
Highlights:
A useful result snippet.
---

Title: Docs &amp; API
URL: https://example.org/docs
Text: Reference material.
---
"""


def make_exa_event_stream(text: str) -> str:
    payload = {"result": {"content": [{"type": "text", "text": text}]}}
    return f"event: message\ndata: {json.dumps(payload)}\n\n"


class DuckDuckGoParserTests(unittest.TestCase):
    def test_parse_results(self) -> None:
        results = _parse_duckduckgo_html(SAMPLE_DUCKDUCKGO_HTML, max_results=10)

        self.assertEqual(
            results,
            [
                {
                    "title": "Paper",
                    "url": "https://example.com/paper",
                    "snippet": "A useful result snippet.",
                },
                {
                    "title": "Docs & API",
                    "url": "https://example.org/docs",
                    "snippet": "Reference material.",
                },
            ],
        )

    def test_decode_non_redirect_url(self) -> None:
        self.assertEqual(
            _decode_duckduckgo_url("https://example.com/path"),
            "https://example.com/path",
        )


class ExaMcpParserTests(unittest.TestCase):
    def test_parse_event_stream_response(self) -> None:
        self.assertEqual(
            _parse_exa_mcp_response(make_exa_event_stream(SAMPLE_EXA_MCP_TEXT)),
            SAMPLE_EXA_MCP_TEXT,
        )

    def test_parse_results(self) -> None:
        results = _parse_exa_mcp_results(SAMPLE_EXA_MCP_TEXT, max_results=10)

        self.assertEqual(
            results,
            [
                {
                    "title": "Paper",
                    "url": "https://example.com/paper",
                    "snippet": "A useful result snippet.",
                },
                {
                    "title": "Docs & API",
                    "url": "https://example.org/docs",
                    "snippet": "Reference material.",
                },
            ],
        )


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_uses_keyless_exa_mcp_search(self) -> None:
        with patch(
            "websearch.websearch._fetch_exa_mcp_text",
            return_value=SAMPLE_EXA_MCP_TEXT,
        ):
            result = await websearch.run(queries=["rlm harness"], max_results=1)

        self.assertEqual(len(result["queries"]), 1)
        query_result = result["queries"][0]
        self.assertEqual(query_result["query"], "rlm harness")
        self.assertEqual(query_result["backend"], "exa-mcp")
        self.assertEqual(len(query_result["results"]), 1)

    async def test_run_falls_back_to_duckduckgo(self) -> None:
        with patch(
            "websearch.websearch._fetch_duckduckgo_html",
            return_value=SAMPLE_DUCKDUCKGO_HTML,
        ), patch(
            "websearch.websearch._fetch_exa_mcp_text",
            side_effect=RuntimeError("Exa unavailable"),
        ):
            result = await websearch.run(queries=["rlm harness"], max_results=1)

        self.assertEqual(len(result["queries"]), 1)
        query_result = result["queries"][0]
        self.assertEqual(query_result["query"], "rlm harness")
        self.assertEqual(query_result["backend"], "duckduckgo")
        self.assertEqual(len(query_result["results"]), 1)

    async def test_run_rejects_empty_queries(self) -> None:
        with self.assertRaisesRegex(ValueError, "queries"):
            await websearch.run(queries=["  "])

    async def test_run_rejects_non_string_queries(self) -> None:
        with self.assertRaisesRegex(TypeError, r"queries\[1\]"):
            await websearch.run(["good", 3])

    async def test_run_rejects_empty_region(self) -> None:
        with self.assertRaisesRegex(ValueError, "region"):
            await websearch.run("rlm harness", region=" ")


class CliTests(unittest.TestCase):
    def test_cli_prints_json_results(self) -> None:
        stdout = io.StringIO()

        with (
            patch("sys.stdout", stdout),
            patch(
                "websearch.websearch._fetch_exa_mcp_text",
                return_value=SAMPLE_EXA_MCP_TEXT,
            ),
        ):
            exit_code = cli(["--queries", "rlm harness", "--max-results", "1"])

        result = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(result["queries"]), 1)
        self.assertEqual(result["queries"][0]["query"], "rlm harness")
        self.assertEqual(result["queries"][0]["backend"], "exa-mcp")
        self.assertEqual(len(result["queries"][0]["results"]), 1)

    def test_cli_exits_cleanly_on_validation_error(self) -> None:
        stderr = io.StringIO()

        with patch("sys.stderr", stderr):
            with self.assertRaises(SystemExit) as raised:
                cli(["--queries", "rlm harness", "--max-results", "0"])

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("max_results", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

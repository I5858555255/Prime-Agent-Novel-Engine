from __future__ import annotations

import json
from pathlib import Path
import inspect
import tomllib
import unittest
from unittest.mock import patch

import websearch
from websearch.websearch import (
	_clean_queries,
	_parse_exa_mcp_response,
	_parse_exa_mcp_results,
)


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


class ExaMcpParserTests(unittest.TestCase):
    def test_parse_event_stream_response(self) -> None:
        self.assertEqual(
            _parse_exa_mcp_response(make_exa_event_stream(SAMPLE_EXA_MCP_TEXT)),
            SAMPLE_EXA_MCP_TEXT,
        )

    def test_parse_json_response(self) -> None:
        payload = {"result": {"content": [{"type": "text", "text": "ok"}]}}

        self.assertEqual(_parse_exa_mcp_response(json.dumps(payload)), "ok")

    def test_parse_exa_error(self) -> None:
        payload = {"error": {"code": -32000, "message": "bad search"}}

        with self.assertRaisesRegex(RuntimeError, "bad search"):
            _parse_exa_mcp_response(json.dumps(payload))

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


class QueryValidationTests(unittest.TestCase):
    def test_clean_queries_deduplicates_after_trimming(self) -> None:
        self.assertEqual(_clean_queries([" prime agent ", "prime agent"]), ["prime agent"])

    def test_clean_queries_rejects_non_string_queries(self) -> None:
        with self.assertRaisesRegex(TypeError, r"queries\[1\]"):
            _clean_queries(["good", 3])


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_uses_keyless_exa_mcp_search(self) -> None:
        with patch(
            "websearch.websearch._fetch_exa_mcp_text",
            return_value=SAMPLE_EXA_MCP_TEXT,
        ) as fetch:
            result = await websearch.run(queries=["rlm harness"], max_results=1)

        fetch.assert_called_once()
        self.assertEqual(len(result["queries"]), 1)
        query_result = result["queries"][0]
        self.assertEqual(query_result["query"], "rlm harness")
        self.assertEqual(query_result["backend"], "exa-mcp")
        self.assertEqual(len(query_result["results"]), 1)

    async def test_run_rejects_empty_queries(self) -> None:
        with self.assertRaisesRegex(ValueError, "queries"):
            await websearch.run(queries=["  "])

    async def test_run_rejects_too_many_unique_queries(self) -> None:
        with self.assertRaisesRegex(ValueError, "at most 5"):
            await websearch.run([f"query {index}" for index in range(6)])

    async def test_run_deduplicates_before_enforcing_query_limit(self) -> None:
        with patch(
            "websearch.websearch._fetch_exa_mcp_text",
            return_value=SAMPLE_EXA_MCP_TEXT,
        ) as fetch:
            result = await websearch.run(["same", " same ", "same"], max_results=1)

        fetch.assert_called_once()
        self.assertEqual([entry["query"] for entry in result["queries"]], ["same"])


class RlmHarnessContractTests(unittest.TestCase):
    def test_pyproject_matches_rlm_harness_skill_contract(self) -> None:
        pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
        pyproject = tomllib.loads(pyproject_path.read_text())

        self.assertEqual(pyproject["project"]["name"], "rlm-skill-websearch")
        self.assertEqual(pyproject["project"]["scripts"]["websearch"], "rlm.skill:cli")
        self.assertIn("rlm", pyproject["project"]["dependencies"])
        self.assertEqual(pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"], ["src/websearch"])
        self.assertEqual(inspect.signature(websearch.run).parameters["queries"].annotation, "list[str]")


if __name__ == "__main__":
    unittest.main()

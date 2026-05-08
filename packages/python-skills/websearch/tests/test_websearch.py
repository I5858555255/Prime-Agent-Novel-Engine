from __future__ import annotations

import unittest
from unittest.mock import patch

import websearch
from websearch.websearch import _decode_duckduckgo_url, _parse_duckduckgo_html


SAMPLE_HTML = """
<html>
  <body>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpaper">Paper</a>
    <a class="result__snippet">A useful result snippet.</a>
    <a class="result__a" href="https://example.org/docs">Docs &amp; API</a>
    <div class="result__snippet">Reference material.</div>
  </body>
</html>
"""


class DuckDuckGoParserTests(unittest.TestCase):
    def test_parse_results(self) -> None:
        results = _parse_duckduckgo_html(SAMPLE_HTML, max_results=10)

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


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_returns_structured_results(self) -> None:
        with patch(
            "websearch.websearch._fetch_duckduckgo_html",
            return_value=SAMPLE_HTML,
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


if __name__ == "__main__":
    unittest.main()

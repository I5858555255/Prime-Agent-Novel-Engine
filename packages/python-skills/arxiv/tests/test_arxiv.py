from __future__ import annotations

import unittest
from unittest.mock import patch

import arxiv
from arxiv.arxiv import _build_query_url, _parse_feed


SAMPLE_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:00:00Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary> The Transformer architecture. </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL" />
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" />
    <link href="http://arxiv.org/pdf/1706.03762v7" title="pdf" />
  </entry>
</feed>
"""


class ParseFeedTests(unittest.TestCase):
    def test_parse_feed(self) -> None:
        parsed = _parse_feed(SAMPLE_FEED)

        self.assertEqual(parsed["total_results"], 1)
        entry = parsed["entries"][0]
        self.assertEqual(entry["id"], "1706.03762v7")
        self.assertEqual(entry["title"], "Attention Is All You Need")
        self.assertEqual(entry["authors"], ["Ashish Vaswani", "Noam Shazeer"])
        self.assertEqual(entry["categories"], ["cs.CL"])
        self.assertEqual(entry["pdf_url"], "https://arxiv.org/pdf/1706.03762v7")

    def test_build_query_url_encodes_parameters(self) -> None:
        url = _build_query_url(
            query="cat:cs.CL transformers",
            ids=None,
            max_results=3,
            sort_by="relevance",
            sort_order="descending",
        )

        self.assertIn("search_query=cat%3Acs.CL+transformers", url)
        self.assertIn("max_results=3", url)


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_fetches_and_parses(self) -> None:
        with patch("arxiv.arxiv._fetch_atom", return_value=SAMPLE_FEED):
            result = await arxiv.run(query="transformers", max_results=1)

        self.assertEqual(result["query"], "transformers")
        self.assertEqual(result["ids"], [])
        self.assertEqual(result["total_results"], 1)
        self.assertEqual(result["entries"][0]["id"], "1706.03762v7")

    async def test_run_requires_query_or_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "query or ids"):
            await arxiv.run()


if __name__ == "__main__":
    unittest.main()

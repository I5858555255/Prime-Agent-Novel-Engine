from __future__ import annotations

import asyncio
import html
from html.parser import HTMLParser
from typing import Literal
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse
from urllib.request import Request, urlopen


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str | None]] = []
        self._in_title = False
        self._in_snippet = False
        self._title_parts: list[str] = []
        self._snippet_parts: list[str] = []
        self._href: str | None = None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attr_map = {name: value or "" for name, value in attrs}
        classes = set(attr_map.get("class", "").split())
        if tag == "a" and "result__a" in classes:
            self._in_title = True
            self._title_parts = []
            self._href = attr_map.get("href")
        if "result__snippet" in classes:
            self._in_snippet = True
            self._snippet_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        if self._in_snippet:
            self._snippet_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            self._in_title = False
            title = _normalize_text("".join(self._title_parts))
            if title and self._href:
                self.results.append(
                    {
                        "title": title,
                        "url": _decode_duckduckgo_url(self._href),
                        "snippet": None,
                    }
                )
            self._title_parts = []
            self._href = None
        if self._in_snippet and tag in {"a", "div"}:
            self._in_snippet = False
            snippet = _normalize_text("".join(self._snippet_parts))
            if snippet and self.results:
                self.results[-1]["snippet"] = snippet
            self._snippet_parts = []


def _normalize_text(value: str) -> str:
    return " ".join(html.unescape(value).split())


def _decode_duckduckgo_url(href: str) -> str:
    absolute = urljoin("https://duckduckgo.com", href)
    parsed = urlparse(absolute)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        uddg = parse_qs(parsed.query).get("uddg")
        if uddg:
            return unquote(uddg[0])
    return absolute


def _parse_duckduckgo_html(document: str, max_results: int) -> list[dict[str, str | None]]:
    parser = _DuckDuckGoParser()
    parser.feed(document)
    return parser.results[:max_results]


def _fetch_duckduckgo_html(
    query: str, *, region: str, timeout_seconds: float
) -> str:
    encoded_query = quote_plus(query)
    url = (
        "https://duckduckgo.com/html/"
        f"?q={encoded_query}&kl={quote_plus(region)}"
    )
    request = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; rlm-skill-websearch/0.1; "
                "+https://primeintellect.ai)"
            )
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


async def _search_duckduckgo(
    query: str, *, max_results: int, region: str, timeout_seconds: float
) -> dict[str, object]:
    document = await asyncio.to_thread(
        _fetch_duckduckgo_html,
        query,
        region=region,
        timeout_seconds=timeout_seconds,
    )
    return {
        "query": query,
        "backend": "duckduckgo",
        "results": _parse_duckduckgo_html(document, max_results=max_results),
    }


async def run(
    queries: list[str],
    max_results: int = 5,
    backend: Literal["duckduckgo"] = "duckduckgo",
    region: str = "us-en",
    timeout_seconds: float = 10.0,
) -> dict[str, object]:
    """Search the web and return ranked results for each query.

    Args:
        queries: Search query strings to run.
        max_results: Maximum number of results per query.
        backend: Search backend. Only `duckduckgo` is currently supported.
        region: DuckDuckGo region code such as `us-en`.
        timeout_seconds: Per-query network timeout in seconds.

    Returns:
        A dictionary containing one structured result set per query.
    """
    cleaned_queries = [query.strip() for query in queries if query.strip()]
    if not cleaned_queries:
        raise ValueError("queries must contain at least one non-empty query")
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    if backend != "duckduckgo":
        raise ValueError(f"unsupported backend: {backend}")

    results = await asyncio.gather(
        *[
            _search_duckduckgo(
                query,
                max_results=max_results,
                region=region,
                timeout_seconds=timeout_seconds,
            )
            for query in cleaned_queries
        ]
    )
    return {"queries": results}

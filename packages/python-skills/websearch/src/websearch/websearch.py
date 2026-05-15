from __future__ import annotations

import asyncio
import html
import json
import re
from collections.abc import Iterable
from typing import Literal, TypedDict
from urllib.error import HTTPError
from urllib.request import Request, urlopen

EXA_MCP_URL = "https://mcp.exa.ai/mcp"
EXA_MCP_TOOL = "web_search_exa"
MAX_QUERIES = 5
MAX_RESULTS = 10
SNIPPET_MAX_CHARS = 500

ResolvedBackend = Literal["exa-mcp"]


class SearchResult(TypedDict):
    title: str
    url: str
    snippet: str | None


class SearchResultSet(TypedDict):
    query: str
    backend: ResolvedBackend
    results: list[SearchResult]


class SearchResponse(TypedDict):
    queries: list[SearchResultSet]


def _normalize_text(value: str) -> str:
    return " ".join(html.unescape(value).split())


def _parse_exa_mcp_response(document: str) -> str:
    parsed: dict[str, object] | None = None
    for line in document.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            candidate = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and (
            "result" in candidate or "error" in candidate
        ):
            parsed = candidate
            break

    if parsed is None:
        try:
            candidate = json.loads(document)
        except json.JSONDecodeError:
            candidate = None
        if isinstance(candidate, dict) and (
            "result" in candidate or "error" in candidate
        ):
            parsed = candidate

    if parsed is None:
        raise RuntimeError("Exa MCP returned an empty response")

    error = parsed.get("error")
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        code_text = f" {code}" if isinstance(code, int) else ""
        message_text = message if isinstance(message, str) else "Unknown error"
        raise RuntimeError(f"Exa MCP error{code_text}: {message_text}")

    result = parsed.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("Exa MCP response was missing a result")

    content = result.get("content")
    if result.get("isError") is True:
        message = _first_text_content(content) or "Exa MCP returned an error"
        raise RuntimeError(message)

    text = _first_text_content(content)
    if not text:
        raise RuntimeError("Exa MCP returned empty content")
    return text


def _first_text_content(content: object) -> str | None:
    if not isinstance(content, list):
        return None
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "text":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            return text
    return None


def _parse_exa_mcp_results(document: str, max_results: int) -> list[SearchResult]:
    results: list[SearchResult] = []
    blocks = re.split(r"(?=^Title: )", document, flags=re.MULTILINE)
    for block in blocks:
        if not block.strip():
            continue
        title_match = re.search(r"^Title: (.+)$", block, flags=re.MULTILINE)
        url_match = re.search(r"^URL: (.+)$", block, flags=re.MULTILINE)
        if not url_match:
            continue

        title = (
            _normalize_text(title_match.group(1))
            if title_match
            else f"Source {len(results) + 1}"
        )
        url = url_match.group(1).strip()
        snippet = _parse_exa_snippet(block)
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


def _parse_exa_snippet(block: str) -> str | None:
    text_marker = "\nText: "
    text_start = block.find(text_marker)
    if text_start >= 0:
        content = block[text_start + len(text_marker) :].strip()
    else:
        highlights_match = re.search(r"\nHighlights:\s*\n", block)
        if not highlights_match:
            return None
        content = block[highlights_match.end() :].strip()

    content = re.sub(r"\n---\s*$", "", content).strip()
    snippet = _normalize_text(content)
    if not snippet:
        return None
    if len(snippet) <= SNIPPET_MAX_CHARS:
        return snippet
    return f"{snippet[: SNIPPET_MAX_CHARS - 3].rstrip()}..."


def _fetch_exa_mcp_text(
    query: str, *, max_results: int, timeout_seconds: float
) -> str:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": EXA_MCP_TOOL,
            "arguments": {
                "query": query,
                "numResults": max_results,
                "livecrawl": "fallback",
                "type": "auto",
                "contextMaxCharacters": 3000,
            },
        },
    }
    request = Request(
        EXA_MCP_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": "prime-agent-skill-websearch/0.1",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        body_text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Exa MCP HTTP {error.code}: {body_text}") from error
    return _parse_exa_mcp_response(raw)


async def _search_exa_mcp(
    query: str, *, max_results: int, timeout_seconds: float
) -> SearchResultSet:
    document = await asyncio.to_thread(
        _fetch_exa_mcp_text,
        query,
        max_results=max_results,
        timeout_seconds=timeout_seconds,
    )
    return {
        "query": query,
        "backend": "exa-mcp",
        "results": _parse_exa_mcp_results(document, max_results=max_results),
    }


def _clean_queries(queries: Iterable[str] | str) -> list[str]:
    if isinstance(queries, str):
        raw_queries: Iterable[str] = [queries]
    else:
        raw_queries = queries

    cleaned_queries: list[str] = []
    seen: set[str] = set()
    for index, query in enumerate(raw_queries):
        if not isinstance(query, str):
            raise TypeError(
                f"queries[{index}] must be str, got {type(query).__name__}"
            )
        stripped = query.strip()
        if stripped and stripped not in seen:
            cleaned_queries.append(stripped)
            seen.add(stripped)
    return cleaned_queries


async def run(
    queries: Iterable[str] | str,
    max_results: int = 5,
    timeout_seconds: float = 10.0,
) -> SearchResponse:
    """Search the web with keyless Exa MCP and return ranked results.

    Args:
        queries: Search query string or iterable of search query strings to run.
        max_results: Maximum number of results per query, capped at 10.
        timeout_seconds: Per-query network timeout in seconds.

    Returns:
        A dictionary containing one structured result set per query.
    """
    cleaned_queries = _clean_queries(queries)
    if not cleaned_queries:
        raise ValueError("queries must contain at least one non-empty query")
    if len(cleaned_queries) > MAX_QUERIES:
        raise ValueError(f"queries supports at most {MAX_QUERIES} queries")
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    capped_max_results = min(max_results, MAX_RESULTS)
    tasks = [
        _search_exa_mcp(
            query,
            max_results=capped_max_results,
            timeout_seconds=timeout_seconds,
        )
        for query in cleaned_queries
    ]
    return {"queries": await asyncio.gather(*tasks)}

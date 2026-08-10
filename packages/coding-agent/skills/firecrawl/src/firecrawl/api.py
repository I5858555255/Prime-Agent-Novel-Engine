"""Firecrawl skill implementation."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

DEFAULT_API_URL = "https://api.firecrawl.dev"

_MISSING_KEY_MESSAGE = (
    "Firecrawl is not set up yet: no Firecrawl API key is configured.\n"
    "Tell the user how to enable it:\n"
    "  1. Get an API key at https://firecrawl.dev (sign up, copy the key).\n"
    '  2. In Prime Agent, run /login, switch to MCP Connections, choose "Firecrawl '
    '(web search + scrape)", and paste the key.\n'
    "Do not ask the user to set environment variables. Once the key is saved, Firecrawl "
    "works automatically."
)


def _env_int(name: str, default: int) -> int:
    """Read an int from the environment, falling back to default on bad values."""
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _agent_dir() -> Path:
    """Resolve the Prime Agent config dir the same way the runtime does."""
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser()


def _resolve_config_value(value: str) -> str:
    # Stored keys may be a literal or an env-var name; "!command" refs can't be run
    # safely here, so skip them (the agent injects those resolved at build time).
    value = value.strip()
    if not value or value.startswith("!"):
        return ""
    return (os.environ.get(value) or value).strip()


def _resolve_api_key() -> str:
    # Read auth.json on each call (not just the injected env var) so a key added
    # via /login after the kernel started is still picked up. Env var wins.
    env_key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    if env_key:
        return env_key

    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get("firecrawl") if isinstance(auth, dict) else None
        if isinstance(cred, dict) and cred.get("type") == "api_key":
            return _resolve_config_value(str(cred.get("key") or ""))
    except (OSError, ValueError):
        pass
    return ""


def _base_url() -> str:
    """API base URL, overridable for self-hosted Firecrawl instances."""
    return (os.environ.get("FIRECRAWL_API_URL") or DEFAULT_API_URL).rstrip("/")


def _timeout() -> int:
    return _env_int("PRIME_AGENT_FIRECRAWL_TIMEOUT", 60)


def _check(data: Any) -> dict[str, Any]:
    """Raise on an explicit API-level failure, else return the decoded body."""
    if isinstance(data, dict) and data.get("success") is False:
        raise RuntimeError(f"Firecrawl error: {data.get('error') or data}")
    return data if isinstance(data, dict) else {}


def _http_error(e: httpx.HTTPStatusError) -> RuntimeError:
    detail = e.response.text if e.response is not None else ""
    return RuntimeError(f"Firecrawl error ({e.response.status_code}): {detail}")


async def _post(path: str, body: dict[str, Any], api_key: str, timeout: int) -> dict[str, Any]:
    """POST a Firecrawl v2 endpoint and return the decoded JSON body."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{_base_url()}/v2{path}",
                json=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        raise _http_error(e) from e

    return _check(data)


async def _get(path: str, params: dict[str, Any], api_key: str, timeout: int) -> dict[str, Any]:
    """GET a Firecrawl v2 endpoint and return the decoded JSON body.

    The research endpoints are GET-only, and httpx encodes a list value as a
    repeated parameter, which is what they expect for multi-valued filters.
    """
    query = {key: value for key, value in params.items() if value not in (None, "", [])}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                f"{_base_url()}/v2{path}",
                params=query,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        raise _http_error(e) from e

    return _check(data)


def _truncate(output: str, max_output: int) -> str:
    """Elide the middle of output so it stays within max_output characters."""
    if len(output) <= max_output:
        return output
    total = len(output)
    marker = f"\n... [output truncated, {total} chars total] ...\n"
    # Reserve room for the marker so the result stays within max_output.
    half = max(0, (max_output - len(marker)) // 2)
    truncated = output[:half] + marker + output[total - half :]
    if len(truncated) > max_output:  # marker alone exceeds the budget
        return truncated[:max_output]
    return truncated


def _format_search_results(results: list[dict[str, Any]], query: str, num_results: int) -> str:
    """Format Firecrawl search results into readable text."""
    sections: list[str] = []
    for i, result in enumerate(results[:num_results]):
        title = (result.get("title") or "").strip() or "Untitled"
        lines = [f"Result {i}: {title}"]
        link = (result.get("url") or "").strip()
        if link:
            lines.append(f"URL: {link}")
        snippet = (result.get("description") or result.get("snippet") or "").strip()
        if snippet:
            lines.append(snippet)
        # Present when the caller asked for content (scrapeOptions).
        markdown = (result.get("markdown") or "").strip()
        if markdown:
            lines.append("")
            lines.append(markdown)
        sections.append("\n".join(lines))

    if not sections:
        return f"No results returned for query: {query}"
    return "\n\n---\n\n".join(sections)


async def run(
    query: str,
    *,
    fetch_content: bool = False,
    max_output: int = 8192,
    timeout: int | None = None,
    num_results: int | None = None,
) -> str:
    """Search the web via Firecrawl and return formatted results.

    Args:
        query: Web search query.
        fetch_content: Also return each result page's markdown (one credit per page).
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.
        num_results: Results to return.

    Returns:
        Formatted search results.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()
    if num_results is None:
        num_results = _env_int("PRIME_AGENT_FIRECRAWL_NUM_RESULTS", 5)

    body: dict[str, Any] = {
        "query": query,
        "sources": [{"type": "web"}],
        "limit": num_results,
    }
    if fetch_content:
        body["scrapeOptions"] = {"formats": ["markdown"], "onlyMainContent": True}

    try:
        data = await _post("/search", body, api_key, timeout)
        web = (data.get("data") or {}).get("web") or []
        result = _format_search_results(web, query, num_results)
    except Exception as e:
        result = f"Error searching for '{query}': {e}"

    return _truncate(f'Results for query "{query}":\n\n{result}', max_output)


async def scrape(
    url: str,
    *,
    formats: list[str] | tuple[str, ...] = ("markdown",),
    only_main_content: bool = True,
    max_output: int = 20000,
    timeout: int | None = None,
) -> str:
    """Fetch a single page through Firecrawl and return it as markdown.

    Args:
        url: Page to fetch.
        formats: Firecrawl formats to request, e.g. ("markdown", "links").
        only_main_content: Strip navigation, headers and other boilerplate.
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        The page's main content as markdown, prefixed with its title and URL.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    body: dict[str, Any] = {
        "url": url,
        "formats": list(formats),
        "onlyMainContent": only_main_content,
        # Firecrawl's own timeout is in milliseconds; keep it just under the HTTP
        # timeout so the API returns an error rather than the client giving up.
        "timeout": max(1, timeout - 5) * 1000,
    }

    try:
        doc = (await _post("/scrape", body, api_key, timeout)).get("data") or {}
    except Exception as e:
        return f"Error scraping {url}: {e}"

    metadata = doc.get("metadata") or {}
    title = (metadata.get("title") or "").strip()
    source = (metadata.get("sourceURL") or url).strip()
    sections = [f"# {title}" if title else "", f"URL: {source}"]

    markdown = (doc.get("markdown") or "").strip()
    if markdown:
        sections.append("\n" + markdown)
    for key in ("links", "summary", "html", "rawHtml"):
        value = doc.get(key)
        if key == "markdown" or not value:
            continue
        rendered = "\n".join(str(v) for v in value) if isinstance(value, list) else str(value)
        sections.append(f"\n## {key}\n{rendered}")
    if not markdown and len(sections) == 2:
        sections.append("\n(no content returned)")

    return _truncate("\n".join(section for section in sections if section), max_output)


# --- developer index -------------------------------------------------------


def _format_developer_results(results: list[dict[str, Any]]) -> str:
    """Format developer-index hits, keeping the matched passages."""
    sections: list[str] = []
    for i, result in enumerate(results):
        title = (result.get("title") or "").strip() or "Untitled"
        kind = (result.get("type") or "").strip()
        lines = [f"Result {i}: {title} [{kind}]" if kind else f"Result {i}: {title}"]
        identifier = (result.get("id") or "").strip()
        if identifier:
            lines.append(f"id: {identifier}")
        url = (result.get("url") or "").strip()
        if url:
            lines.append(f"URL: {url}")
        for passage in result.get("passages") or []:
            text = (passage.get("text") or "").strip() if isinstance(passage, dict) else str(passage).strip()
            if text:
                lines.append("")
                lines.append(text)
        sections.append("\n".join(lines))
    return "\n\n---\n\n".join(sections)


async def developer(
    query: str,
    *,
    k: int = 10,
    types: list[str] | tuple[str, ...] | None = None,
    repos: list[str] | tuple[str, ...] | None = None,
    sources: list[str] | tuple[str, ...] | None = None,
    passages: int = 1,
    skills_only: bool = False,
    max_output: int = 12000,
    timeout: int | None = None,
) -> str:
    """Search the Firecrawl developer index: issues, PRs, READMEs and docs.

    Answers a programming question from the primary source and returns the
    matched passages, so a follow-up scrape is usually unnecessary. Prefer this
    over a web search for error strings, API contracts and known bugs.

    Args:
        query: Error string or natural-language question.
        k: Results to return (1-100).
        types: Restrict to any of "doc", "issue", "pull_request", "readme".
        repos: Restrict repository hits to these "owner/name" slugs.
        sources: Restrict doc hits to these documentation source ids (max 20).
        passages: Maximum matched passages per result (1-5).
        skills_only: Search only indexed agent-skill files.
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        Ranked results with their matched passages.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    body: dict[str, Any] = {"query": query, "k": k, "passages": passages}
    if types:
        body["types"] = list(types)
    if repos:
        body["repos"] = list(repos)
    if sources:
        body["sources"] = list(sources)
    if skills_only:
        body["skills"] = "only"

    try:
        data = await _post("/search/developer", body, api_key, timeout)
    except Exception as e:
        return f"Error searching the developer index for '{query}': {e}"

    results = data.get("results") or []
    if not results:
        # coverage reports which halves of the index answered; a filter that
        # excludes every requested type is the usual cause of an empty list.
        coverage = data.get("coverage") or {}
        detail = f" (coverage: {coverage})" if coverage else ""
        return f"No developer-index results for: {query}{detail}"

    header = f'Developer index results for "{query}":\n\n'
    return _truncate(header + _format_developer_results(results), max_output)


# --- research index --------------------------------------------------------

#: Abstracts run long; list views show a prefix and point at read_paper/inspect_paper.
_ABSTRACT_PREVIEW = 500


def _format_papers(results: list[dict[str, Any]], abstract_chars: int = _ABSTRACT_PREVIEW) -> str:
    """Format research-index paper hits."""
    sections: list[str] = []
    for i, paper in enumerate(results):
        title = (paper.get("title") or "").strip() or "Untitled"
        lines = [f"Paper {i}: {title}"]
        identifier = (paper.get("primaryId") or paper.get("paperId") or "").strip()
        if identifier:
            lines.append(f"id: {identifier}")
        abstract = (paper.get("abstract") or "").strip()
        if abstract:
            if len(abstract) > abstract_chars:
                abstract = f"{abstract[:abstract_chars].rstrip()}… [read_paper/inspect_paper for the rest]"
            lines.append(abstract)
        sections.append("\n".join(lines))
    return "\n\n---\n\n".join(sections)


async def research(
    query: str,
    *,
    k: int = 10,
    authors: list[str] | tuple[str, ...] | None = None,
    categories: list[str] | tuple[str, ...] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    max_output: int = 8192,
    timeout: int | None = None,
) -> str:
    """Search the Firecrawl research index over paper abstracts.

    Args:
        query: Natural-language paper search query.
        k: Papers to return (1-500).
        authors: Author substring filters.
        categories: Category filters.
        date_from: Inclusive lower bound, "YYYY-MM-DD".
        date_to: Inclusive upper bound, "YYYY-MM-DD".
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        Ranked papers with ids and abstract previews.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    params: dict[str, Any] = {"query": query, "k": k}
    if authors:
        params["authors"] = list(authors)
    if categories:
        params["categories"] = list(categories)
    if date_from:
        params["from"] = date_from
    if date_to:
        params["to"] = date_to

    try:
        data = await _get("/search/research/papers", params, api_key, timeout)
    except Exception as e:
        return f"Error searching the research index for '{query}': {e}"

    results = data.get("results") or []
    if not results:
        return f"No papers found for: {query}"
    return _truncate(f'Papers for "{query}":\n\n' + _format_papers(results), max_output)


async def related_papers(
    paper_id: str,
    intent: str,
    *,
    mode: str = "similar",
    k: int = 10,
    max_output: int = 8192,
    timeout: int | None = None,
) -> str:
    """Expand one paper into the rest of its set, ranked by intent.

    Reaches papers abstract search cannot: "similar" finds niche siblings,
    "citers" who builds on it, "references" what it builds on.

    Args:
        paper_id: Seed paper reference, e.g. "arxiv:2105.05233".
        intent: What you want the neighbors for; used for semantic ranking.
        mode: "similar", "citers" or "references".
        k: Papers to return (1-500).
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        Ranked related papers with ids and abstract previews.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    params = {"intent": intent, "mode": mode, "k": k}
    try:
        data = await _get(f"/search/research/papers/{quote(paper_id, safe='')}/similar", params, api_key, timeout)
    except Exception as e:
        return f"Error finding papers related to {paper_id}: {e}"

    results = data.get("results") or []
    if not results:
        return f"No related papers found for {paper_id} (mode={mode})"
    header = f'Papers related to {paper_id} (mode={mode}, intent "{intent}"):\n\n'
    return _truncate(header + _format_papers(results), max_output)


async def inspect_paper(paper_id: str, *, max_output: int = 8192, timeout: int | None = None) -> str:
    """Return canonical metadata for one paper: title, authors, abstract, dates.

    Args:
        paper_id: Paper reference, e.g. "arxiv:2105.05233".
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        The paper's metadata and full abstract.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    try:
        data = await _get(f"/search/research/papers/{quote(paper_id, safe='')}", {}, api_key, timeout)
    except Exception as e:
        return f"Error inspecting {paper_id}: {e}"

    paper = data.get("paper") or {}
    if not paper:
        return f"No paper found for {paper_id}"

    lines = [f"# {(paper.get('title') or '').strip() or paper_id}"]
    for label, key in (("id", "paperId"), ("authors", "authors"), ("created", "createdDate"), ("updated", "updateDate")):
        value = paper.get(key)
        if value:
            lines.append(f"{label}: {value}")
    categories = paper.get("categories") or []
    if categories:
        lines.append(f"categories: {', '.join(str(c) for c in categories)}")
    abstract = (paper.get("abstract") or "").strip()
    if abstract:
        lines.append(f"\n{abstract}")
    return _truncate("\n".join(lines), max_output)


async def read_paper(
    paper_id: str,
    question: str,
    *,
    k: int = 4,
    max_output: int = 12000,
    timeout: int | None = None,
) -> str:
    """Read passages from one paper's body to answer a specific question.

    Use this to settle a load-bearing detail — a method actually used, a score
    actually reported — rather than inferring it from the abstract.

    Args:
        paper_id: Paper reference, e.g. "arxiv:2105.05233".
        question: What to look for in the body.
        k: Passages to return (1-50).
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.

    Returns:
        The matching passages, most relevant first.
    """
    api_key = _resolve_api_key()
    if not api_key:
        return _MISSING_KEY_MESSAGE

    if timeout is None:
        timeout = _timeout()

    try:
        data = await _get(
            f"/search/research/papers/{quote(paper_id, safe='')}",
            {"query": question, "k": k},
            api_key,
            timeout,
        )
    except Exception as e:
        return f"Error reading {paper_id}: {e}"

    passages = data.get("passages") or []
    if not passages:
        return f"No passages in {paper_id} matched: {question}"

    title = ((data.get("paper") or {}).get("title") or "").strip() or paper_id
    sections = [f'Passages from "{title}" for: {question}\n']
    for i, passage in enumerate(passages):
        text = (passage.get("text") or "").strip() if isinstance(passage, dict) else str(passage).strip()
        if text:
            sections.append(f"[{i}] {text}")
    return _truncate("\n\n".join(sections), max_output)

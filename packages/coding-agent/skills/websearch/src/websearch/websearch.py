"""Websearch skill implementation."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote

import httpx

MCP_EXA_URL = "https://mcp.exa.ai/mcp"
MCP_PARALLEL_URL = "https://search.parallel.ai/mcp"


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


def _resolve_api_key() -> str:
    # Read auth.json on each call (not just the injected env var) so a key added
    # via /login after the kernel started is still picked up. Env var wins.
    env_key = os.environ.get("SERPER_API_KEY", "").strip()
    if env_key:
        return env_key

    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get("serper") if isinstance(auth, dict) else None
        if isinstance(cred, dict) and cred.get("type") == "api_key":
            return _resolve_config_value(str(cred.get("key") or ""))
    except (OSError, ValueError):
        pass
    return ""


def _resolve_config_value(value: str) -> str:
    # Stored keys may be a literal or an env-var name; "!command" refs can't be run
    # safely here, so skip them (the agent injects those resolved at build time).
    value = value.strip()
    if not value or value.startswith("!"):
        return ""
    return (os.environ.get(value) or value).strip()


def _format_serper_results(data: dict, query: str, num_results: int = 5) -> str:
    """Format a Serper API response into readable text."""
    sections: list[str] = []

    kg = data.get("knowledgeGraph")
    if kg:
        kg_lines: list[str] = []
        title = (kg.get("title") or "").strip()
        if title:
            kg_lines.append(f"Knowledge Graph: {title}")
        description = (kg.get("description") or "").strip()
        if description:
            kg_lines.append(description)
        for key, value in (kg.get("attributes") or {}).items():
            text = str(value).strip()
            if text:
                kg_lines.append(f"{key}: {text}")
        if kg_lines:
            sections.append("\n".join(kg_lines))

    for i, result in enumerate((data.get("organic") or [])[:num_results]):
        title = (result.get("title") or "").strip() or "Untitled"
        lines = [f"Result {i}: {title}"]
        link = (result.get("link") or "").strip()
        if link:
            lines.append(f"URL: {link}")
        snippet = (result.get("snippet") or "").strip()
        if snippet:
            lines.append(snippet)
        sections.append("\n".join(lines))

    people_also_ask = data.get("peopleAlsoAsk") or []
    if people_also_ask:
        max_q = max(1, min(3, len(people_also_ask)))
        questions: list[str] = []
        for item in people_also_ask[:max_q]:
            question = (item.get("question") or "").strip()
            if not question:
                continue
            entry = f"Q: {question}"
            answer = (item.get("snippet") or "").strip()
            if answer:
                entry += f"\nA: {answer}"
            questions.append(entry)
        if questions:
            sections.append("People Also Ask:\n" + "\n".join(questions))

    if not sections:
        return f"No results returned for query: {query}"

    return "\n\n---\n\n".join(sections)


def _mcp_url(base: str, env_key: str) -> str:
    """Build a keyless MCP endpoint URL, appending an optional API key query param."""
    api_key = os.environ.get(env_key, "").strip()
    if api_key:
        return f"{base}?exaApiKey={quote(api_key)}"
    return base


def _parse_mcp_response(body: str) -> str | None:
    """Extract the first text result from an MCP tools/call response.

    Accepts both a direct JSON body and the SSE framing some servers use
    (lines prefixed with ``data: ``). Mirrors opencode's parseResponse.
    """
    candidates: list[str] = [body.strip()]
    for line in body.split("\n"):
        if line.startswith("data: "):
            candidates.append(line[6:].strip())
    for candidate in candidates:
        if not candidate or not candidate.startswith("{"):
            continue
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        result = data.get("result")
        if not isinstance(result, dict):
            continue
        for item in result.get("content") or []:
            if isinstance(item, dict) and item.get("text"):
                return item["text"]
    return None


async def _mcp_call(
    url: str,
    tool: str,
    arguments: dict,
    timeout: int,
    *,
    headers: dict[str, str] | None = None,
) -> str:
    """Execute an MCP ``tools/call`` and return the first text result."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    request_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if headers:
        request_headers.update(headers)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=request_headers)
            resp.raise_for_status()
            body = resp.text
    except httpx.HTTPStatusError as e:
        text = e.response.text if e.response is not None else ""
        raise RuntimeError(f"{tool} error ({e.response.status_code}): {text}") from e
    result = _parse_mcp_response(body)
    if not result:
        raise RuntimeError(f"{tool} returned no text results")
    return result


async def _fetch_exa(query: str, timeout: int = 45, num_results: int = 5) -> str:
    """Search via Exa's public MCP server (keyless unless EXA_API_KEY is set)."""
    arguments = {
        "query": query,
        "type": "auto",
        "numResults": num_results,
        "livecrawl": "fallback",
        "contextMaxCharacters": 10000,
    }
    return await _mcp_call(
        _mcp_url(MCP_EXA_URL, "EXA_API_KEY"), "web_search_exa", arguments, timeout
    )


async def _fetch_parallel(query: str, timeout: int = 45) -> str:
    """Search via Parallel's public MCP server (keyless unless PARALLEL_API_KEY is set)."""
    arguments = {"objective": query, "search_queries": [query]}
    headers = {}
    api_key = os.environ.get("PARALLEL_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return await _mcp_call(
        MCP_PARALLEL_URL, "web_search", arguments, timeout, headers=headers
    )


async def _fetch_serper(
    query: str, api_key: str, timeout: int = 45, num_results: int = 5
) -> str:
    """Execute a single Serper API search."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                "https://google.serper.dev/search",
                json={"q": query},
                headers={
                    "X-API-KEY": api_key,
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        body = e.response.text if e.response is not None else ""
        raise RuntimeError(
            f"Serper search error ({e.response.status_code}): {body}"
        ) from e

    return _format_serper_results(data, query, num_results=num_results)


async def run(
    query: str,
    *,
    max_output: int = 8192,
    timeout: int | None = None,
    num_results: int | None = None,
) -> str:
    """Run a web search and return formatted results.

    Backend priority: Serper (when an API key is configured), then Exa's
    keyless MCP server, then Parallel's keyless MCP server. Only if every
    backend fails is the setup-guide message returned.

    Args:
        query: Web search query.
        max_output: Truncate output to this many chars.
        timeout: HTTP timeout in seconds.
        num_results: Organic results to return.

    Returns:
        Formatted search results.
    """
    if timeout is None:
        timeout = _env_int("PRIME_AGENT_WEBSEARCH_TIMEOUT", 45)
    if num_results is None:
        num_results = _env_int("PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5)

    backend_errors: list[str] = []

    api_key = _resolve_api_key()
    if api_key:
        try:
            result = await _fetch_serper(
                query, api_key, timeout=timeout, num_results=num_results
            )
            backend = "Serper"
        except Exception as e:
            backend_errors.append(f"Serper: {e}")
            result = ""
    else:
        result = ""

    if not result:
        try:
            result = await _fetch_exa(query, timeout=timeout, num_results=num_results)
            backend = "Exa"
        except Exception as e:
            backend_errors.append(f"Exa: {e}")
            result = ""

    if not result:
        try:
            result = await _fetch_parallel(query, timeout=timeout)
            backend = "Parallel"
        except Exception as e:
            backend_errors.append(f"Parallel: {e}")
            result = ""

    if not result:
        if backend_errors:
            failure = "; ".join(backend_errors)
            result = f"Error searching for '{query}': {failure}"
        else:
            result = (
                "Web search returned no results, and no Serper API key is configured.\n"
                "Tell the user how to enable higher-quality results:\n"
                "  1. Get a free API key at https://serper.dev (sign up, copy the key).\n"
                '  2. In Prime Agent, run /login, switch to MCP Connections, choose "Serper (web search)", and paste the key.\n'
                "Do not ask the user to set environment variables. Web search already works without it."
            )
    else:
        result = f"[{backend}] {result}"

    output = f'Results for query "{query}":\n\n{result}'

    if len(output) > max_output:
        total = len(output)
        marker = f"\n... [output truncated, {total} chars total] ...\n"
        # Reserve room for the marker so the result stays within max_output.
        half = max(0, (max_output - len(marker)) // 2)
        output = output[:half] + marker + output[len(output) - half :]
        if len(output) > max_output:  # marker alone exceeds the budget
            output = output[:max_output]

    return output

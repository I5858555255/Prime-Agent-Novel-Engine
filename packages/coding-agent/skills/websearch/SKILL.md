---
name: websearch
description: "Search the web. Backends, in priority order: Serper (web search), configured via /login → MCP Connections → Serper, adds knowledge-graph and people-also-ask data; then Exa's and Parallel's keyless MCP servers. Takes one query and returns titles, URLs, and snippets."
---

# Web Search

Search the web. Works out of the box with no API key by falling back to
Exa's and Parallel's public MCP servers; configuring a Serper key adds
richer results (knowledge graph, people-also-ask).

## Setup

Web search works immediately with no configuration. For higher-quality
results, get a free API key at https://serper.dev, then run `/login` in
Prime Agent, switch to **MCP Connections**, and choose **Serper (web search)**
to paste it. The key is stored in Prime Agent and made available to this
skill automatically.

If web search reports an error, don't ask the user to set environment variables.

Optional overrides (environment variables):

- `PRIME_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5).
- `EXA_API_KEY` - optional Exa API key (uses `https://mcp.exa.ai/mcp?exaApiKey=...`).
- `PARALLEL_API_KEY` - optional Parallel API key (adds an `Authorization: Bearer` header).

## Usage

Call the prepared `websearch` import directly in the IPython kernel:

```python
print(await websearch("latest Prime Agent release"))
```

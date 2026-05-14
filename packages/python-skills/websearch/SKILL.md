---
name: websearch
description: Search the web from Prime Agent's Python kernel and return structured source results. Use when current web search results are needed before choosing pages to inspect.
---

# websearch

Use `websearch` when the agent needs current web search results before deciding
what to read next.

## Python

```python
import websearch

results = await websearch.run(
    queries=["latest jupyter_client release"],
    max_results=5,
)
```

For a single query, a string is accepted:

```python
results = await websearch.run("latest jupyter_client release")
```

No API key or account setup is required. The skill uses Exa's public MCP search
endpoint by default and falls back to DuckDuckGo HTML results when the MCP
endpoint is unavailable.

`run(...)` returns a dictionary with one `queries` entry per input query. Each
entry includes the `backend` used and ranked `results` with `title`, `url`, and
`snippet` fields when the search backend provides them.

## CLI

```bash
websearch --queries "latest jupyter_client release" --max-results 5
```

Prefer targeted queries. Use search results to identify sources, then fetch and
inspect the original pages before relying on specific facts.

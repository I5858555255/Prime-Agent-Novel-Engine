---
name: websearch
description: Search the web from Prime Agent's IPython kernel and return structured source results. Use when current web search results are needed before choosing pages to inspect.
---

# websearch

Use `websearch` when current web search results are needed before deciding what
to read next.

## Python

```python
results = await websearch(
    queries=["latest jupyter_client release"],
    max_results=5,
)
```

For a single query, a string is accepted:

```python
results = await websearch("latest jupyter_client release")
```

No API key or account setup is required. The skill uses Exa's public MCP search
endpoint.

The skill also exposes `await websearch.run(...)`. The call returns a dictionary
with one `queries` entry per input query. Each entry includes the `backend` used
and ranked `results` with `title`, `url`, and `snippet` fields when the search
backend provides them.

Prefer targeted queries. Use search results to identify sources, then fetch and
inspect the original pages before relying on specific facts.

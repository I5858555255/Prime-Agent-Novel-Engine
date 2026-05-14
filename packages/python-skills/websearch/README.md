# websearch

Prime Agent skill for lightweight web search from the IPython kernel.

## Python

```python
import websearch

results = await websearch.run("latest jupyter_client release", max_results=5)
```

`run(...)` accepts either a single query string or an iterable of query strings.
It returns one structured result set per query with the `backend` used plus
`title`, `url`, and `snippet` fields for each result.

No API key or account setup is required. The skill uses Exa's public MCP search
endpoint by default and falls back to DuckDuckGo HTML results when the MCP
endpoint is unavailable.

## CLI

```bash
websearch --queries "latest jupyter_client release" --max-results 5
```

The `websearch` console script prints compact JSON results to stdout.

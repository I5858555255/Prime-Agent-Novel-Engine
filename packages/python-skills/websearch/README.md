# websearch

Prime Agent skill for lightweight web search from the IPython kernel.

## Python

```python
results = await websearch(queries=["latest jupyter_client release"], max_results=5)
```

`websearch(...)` and `websearch.run(...)` accept query strings and return one
structured result set per query with the `backend` used plus `title`, `url`, and
`snippet` fields for each result. A single query string is accepted as a
convenience in Python.

No API key or account setup is required. The skill uses Exa's public MCP search
endpoint.

When installed as an `rlm-harness` skill package, the shared CLI entry exposes:

```bash
websearch --queries "latest jupyter_client release"
```

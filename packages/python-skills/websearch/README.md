# websearch

Prime Agent skill for lightweight web search from the IPython kernel.

## Python

```python
results = await websearch.run("latest jupyter_client release", max_results=5)
```

`run(...)` accepts either a single query string or an iterable of query strings.
It returns one structured result set per query with the `backend` used plus
`title`, `url`, and `snippet` fields for each result.

No API key or account setup is required. The skill uses Exa's public MCP search
endpoint.

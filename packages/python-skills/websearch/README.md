# websearch

Prime Agent skill for lightweight web search from the IPython kernel.

## Python

```python
import websearch

results = await websearch.run(queries=["latest jupyter_client release"], max_results=5)
```

`run(...)` accepts either a single query string or an iterable of query strings.
It returns one structured result set per query with `title`, `url`, and
`snippet` fields.

## CLI

```bash
websearch --queries "latest jupyter_client release" --max-results 5
```

The `websearch` console script prints compact JSON results to stdout.

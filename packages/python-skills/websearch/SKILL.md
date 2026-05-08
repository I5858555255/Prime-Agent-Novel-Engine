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

`run(...)` returns a dictionary with one `queries` entry per input query. Each
entry includes ranked `results` with `title`, `url`, and `snippet` fields when
the search backend provides them.

## CLI

```bash
websearch --queries "latest jupyter_client release" --max-results 5
```

Prefer targeted queries. Use search results to identify sources, then fetch and
inspect the original pages before relying on specific facts.

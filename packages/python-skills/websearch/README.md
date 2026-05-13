# websearch

RLM skill for lightweight web search from the IPython kernel.

```python
import websearch

results = await websearch.run(queries=["latest jupyter_client release"], max_results=5)
```

The package exposes a single async `run(...)` entrypoint and a `websearch`
console script that prints JSON results.

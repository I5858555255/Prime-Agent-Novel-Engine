# arxiv

RLM skill for arXiv paper search and structured metadata retrieval.

```python
import arxiv

papers = await arxiv.run(query="cat:cs.CL retrieval augmented generation", max_results=5)
```

The package exposes a single async `run(...)` entrypoint and an `arxiv`
console script through `rlm.skill:cli`.

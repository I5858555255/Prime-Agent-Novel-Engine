# arxiv

Use `arxiv` when the agent needs to find papers or inspect arXiv metadata,
abstracts, authors, categories, and PDF links.

## Python

```python
import arxiv

papers = await arxiv.run(
    query="cat:cs.CL retrieval augmented generation",
    max_results=5,
)
```

Fetch specific papers by arXiv ID:

```python
papers = await arxiv.run(ids=["1706.03762", "2402.03216"])
```

`run(...)` returns a dictionary with `entries`; each entry includes `id`,
`title`, `summary`, `authors`, `categories`, `published`, `updated`,
`abs_url`, and `pdf_url`.

## CLI

```bash
arxiv --query "cat:cs.CL retrieval augmented generation" --max-results 5
arxiv --ids 1706.03762 --ids 2402.03216
```

Use the returned metadata to decide which papers to fetch or summarize. Do not
treat abstracts as a substitute for reading the paper when exact claims matter.

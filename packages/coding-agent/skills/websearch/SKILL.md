---
name: websearch
description: Search Google via the Serper API. Takes a single query. Returns titles, URLs, snippets, and knowledge-graph data.
---

# Web Search

Search the web via the Serper Google Search API.

## Setup

Set the `SERPER_API_KEY` environment variable. Get a key at https://serper.dev.

Optional overrides:

- `PRIME_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5).

## Usage

Call the prepared `websearch` import directly in the IPython kernel:

```python
print(await websearch.run("latest Prime Agent release"))
```

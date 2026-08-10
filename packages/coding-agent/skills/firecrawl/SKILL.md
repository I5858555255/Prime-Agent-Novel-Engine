---
name: firecrawl
description: Search the web, read web pages as markdown, answer programming questions from GitHub issues, pull requests, READMEs and docs, and find and read research papers — all via the Firecrawl API. Configure access via /login, then MCP Connections, then Firecrawl (web search + scrape). Use the developer index for error strings, API contracts and known bugs, and the research index for literature questions, rather than a general web search.
---

# Firecrawl

Web search and page extraction via the Firecrawl API, plus two specialized
indexes. Unlike a search-only skill, this can read what it finds.

## Setup

Get an API key at https://firecrawl.dev, then run `/login` in Prime Agent,
switch to **MCP Connections**, and choose **Firecrawl (web search + scrape)**
to paste it. The key is stored in Prime Agent and made available to this skill
automatically.

If Firecrawl reports a missing key, walk the user through those two steps;
don't ask them to set environment variables.

Optional overrides (environment variables):

- `FIRECRAWL_API_URL` - API base URL (default `https://api.firecrawl.dev`); point
  this at a self-hosted instance to avoid the cloud API.
- `PRIME_AGENT_FIRECRAWL_TIMEOUT` - HTTP timeout in seconds (default 60).
- `PRIME_AGENT_FIRECRAWL_NUM_RESULTS` - search results to return (default 5).

## Usage

Call the prepared `firecrawl` import directly in the IPython kernel:

```python
# Search: titles, URLs, snippets.
print(await firecrawl("latest Prime Agent release"))

# Search and read the results in one call — costs one credit per page.
print(await firecrawl("prime intellect INTELLECT-3", fetch_content=True))

# Read one known page as markdown.
print(await firecrawl.scrape("https://docs.firecrawl.dev/introduction"))
```

Every call truncates its output to keep the transcript small; raise `max_output`
when you genuinely need the whole page, or pass `formats=["markdown", "links"]`
to `scrape` for more than the main content.

Prefer `scrape` on a known URL over `firecrawl(..., fetch_content=True)` when
you already know where the answer lives.

## Developer index

For a programming question, go to the primary source — the issue where the bug
was reported, the PR that fixed it, the README or doc page that states the
contract — instead of a general web search. Results carry the **matched
passages**, so you can usually answer without a follow-up scrape.

```python
print(await firecrawl.developer("TypeError: cannot read properties of undefined"))
print(await firecrawl.developer("httpx retry semantics", types=["issue", "pull_request"]))
print(await firecrawl.developer("uv venv layout", repos=["astral-sh/uv"], passages=3))
```

- `types` (`doc`, `issue`, `pull_request`, `readme`) is the cheapest way to
  sharpen a query; for a literal error string use `["issue", "pull_request"]`.
- `repos` scopes the repository half, `sources` the documentation half; passing
  both **unions** them rather than intersecting.
- Raise `passages` (1-5) before raising `k` when one page is clearly right but
  the first passage is the wrong part of it.
- A filter that can't match any requested type returns a 400, and an empty
  result reports `coverage` so you can tell "not indexed" from "no match".

## Research index

Semantic search over paper abstracts, structural expansion from a seed paper,
and in-body reading of one paper.

```python
print(await firecrawl.research("training-free detection of AI-generated text"))
print(await firecrawl.inspect_paper("arxiv:2105.05233"))
print(await firecrawl.related_papers("arxiv:2105.05233", intent="rival methods", mode="citers"))
print(await firecrawl.read_paper("arxiv:2105.05233", "what FID did they report on ImageNet?"))
```

- Start with `research`. If results look thin or all alike, re-frame the query
  (sibling domain, rival method, benchmark name) rather than giving up.
- `related_papers` reaches papers abstract search cannot: `mode="similar"` for
  niche siblings, `"citers"` for who builds on it, `"references"` for what it
  builds on.
- Search and expansion show only an abstract preview. Use `inspect_paper` for
  full metadata and the whole abstract, and `read_paper` to settle a specific
  load-bearing claim from the body — not on every candidate.

---
name: tavily
description: Search the web, extract pages, map and crawl sites, conduct research, and retrieve technical documentation via Tavily's official hosted MCP server. Tools are auto-discovered at runtime.
---

# Tavily

Use Tavily's official hosted MCP server from the IPython kernel.

## Setup

Connect via `/login` → **Services** tab → **Tavily** (OAuth in the browser).
`/mcp login tavily` does the same. Once connected, this skill is enabled
automatically. If a call raises `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The server currently provides tools for search, extraction, mapping, crawling and deep research.
The server remains the source of truth, so discover its current tools and argument schemas before calling:

```python
import tavily

# 1. Discover available tools and their schemas
for tool in await tavily.list_tools():
    print(tool["name"], "-", tool["description"])

# 2. Inspect a tool after discovery
help(tavily.tavily_search)

# 3. Call it with arguments from its schema
result = await tavily.tavily_search(
    query="latest developments in AI inference",
    max_results=5,
    search_depth="basic",
)
print(result)
```

Notes:

- Every call is `async` — always `await` it.
- Results are already-parsed Python: a `dict` for structured output, a string for
  text, or a list of content blocks otherwise. Do not call `json.loads` on them.
- Run `list_tools()` before assuming a tool or argument exists; it also populates
  the schemas and docstrings shown by `help()`.
- For a tool name that is not a valid Python identifier, use
  `await tavily.call_tool("tool-name", {"argument": "value"})`.
- The kernel import name is `tavily`. A custom `PRIME_AGENT_KERNEL_PYTHON` that
  already contains the `tavily-python` SDK may resolve that package instead; use
  Prime Agent's default managed kernel environment to avoid the collision.

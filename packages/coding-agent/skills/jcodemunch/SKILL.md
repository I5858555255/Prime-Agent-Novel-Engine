---
name: jcodemunch
description: Structured code retrieval through an optional, separately installed jCodeMunch MCP sidecar over host-managed stdio or HTTP. Use to locate symbols, inspect bounded source/context, trace references, assess refactor blast radius, or map changed symbols without loading a repository wholesale.
---

# jCodeMunch

Use jCodeMunch for precision code retrieval. It is optional: importing this
skill never installs, starts, indexes, upgrades, or otherwise changes a sidecar.
Call `available()` first when setup is unknown. If unavailable, use Prime
Agent's normal file tools instead.

```python
import jcodemunch

print(await jcodemunch.available())
tools = await jcodemunch.list_tools()
print([tool["name"] for tool in tools])
```

## Setup

Install and operate jCodeMunch separately, and review the sidecar's license
terms before use. This skill does not include or copy jCodeMunch. The skill is
bundled and available by default; when `mcpServers.jcodemunch` is absent, Prime
Agent uses the separately installed `jcodemunch-mcp` command as a lazy
host-managed stdio transport. Add an explicit entry when you need to override
its command, args, environment, cwd, tool filters, or enabled state:

```jsonc
{
  "mcpServers": {
    "jcodemunch": {
      "type": "stdio",
      "command": "jcodemunch-mcp"
    }
  }
}
```

The host launches configured stdio servers lazily and keeps command, args,
environment, and cwd host-side. The Python skill uses the host bridge for
`list_tools` and `call_tool`; it never launches a process itself. Set
`"enabled": false` to disable the default without falling back to an
environment URL. If a sidecar's CLI syntax is not documented, use a safe
placeholder such as
`/path/to/separately-installed-mcp-server` rather than guessing flags or
secrets.

Alternatively, configure a **streamable HTTP** endpoint either with
`JCODEMUNCH_MCP_URL` or in Prime Agent settings:

```jsonc
{
  "mcpServers": {
    "jcodemunch": {
      "type": "http",
      "url": "https://localhost.example/jcodemunch/mcp",
      "bearerTokenEnvVar": "JCODEMUNCH_MCP_TOKEN"
    }
  }
}
```

The URL and token names are examples, not sidecar defaults. For an endpoint
that needs no token, omit `bearerTokenEnvVar`. For one that does, export
`JCODEMUNCH_MCP_TOKEN` or supply its authorization header in `headers`.
Do not auto-install, start, reindex, upgrade, remove, or purge the sidecar.

## Retrieval workflow

Discover server-owned schemas before relying on optional arguments. The skill
exposes only the retrieval tools below; use `call_tool(name, arguments)` for
exact server names and dynamic schemas.

1. `search_symbols`: find candidate symbol IDs.
2. `get_file_outline`: inspect file structure before retrieving source.
3. `get_symbol_source`: retrieve the exact implementation; use server-supported
   verification options when drift matters.
4. `get_context_bundle` or `get_ranked_context`: obtain bounded, task-focused
   code plus dependencies/imports.
5. `find_references` or `find_importers`: verify usage and file dependencies.
6. `get_blast_radius`: assess impact before a rename, deletion, or refactor.
7. `get_changed_symbols`: map a local indexed diff or PR range to symbols.
8. `plan_turn`: create or continue a server-supported retrieval plan.
9. `assemble_task_context`: assemble bounded context for the current retrieval task.

```python
hits = await jcodemunch.search_symbols(
    repo="prime-agent", query="McpIntegration", detail_level="compact"
)
outline = await jcodemunch.get_file_outline(
    repo="prime-agent", file_path="prime-agent-runtime/src/rlm/mcp_base.py"
)
source = await jcodemunch.get_symbol_source(
    repo="prime-agent", symbol_id=hits[0]["symbol_id"], verify=True
)
context = await jcodemunch.get_context_bundle(
    repo="prime-agent", symbol_id=hits[0]["symbol_id"], token_budget=4000
)
references = await jcodemunch.find_references(
    repo="prime-agent", identifier="McpIntegration", max_results=50
)
impact = await jcodemunch.get_blast_radius(
    repo="prime-agent", symbol="McpIntegration", depth=2
)
changed = await jcodemunch.get_changed_symbols(
    repo="prime-agent", since_sha="main", until_sha="HEAD"
)
```

The server remains the source of truth for parameter names and availability.
Common advanced options include token budgets, file/language filters, semantic
or fusion ranking, source context lines, and call-chain depth; inspect
`list_tools()` before using them. Preserve the server's license boundary: this
skill only exposes the allowlisted retrieval surface and does not include,
copy, or manage the separately installed sidecar.

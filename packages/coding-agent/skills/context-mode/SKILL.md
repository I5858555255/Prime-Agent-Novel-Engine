---
name: context-mode
description: Bounded large-output processing through an optional, separately installed Context Mode MCP sidecar over host-managed stdio or HTTP. Use for large web pages, documentation, changelogs, logs, and isolated file or command analysis when a compact derived result is preferable.
---

# Context Mode

Use Context Mode only for bounded collection, indexing, search, and isolated
processing. It is not a security sandbox: a configured sidecar uses its own
filesystem and network permissions. Importing this skill never installs,
starts, upgrades, purges, or changes a sidecar.

```python
import context_mode

print(await context_mode.available())
print([tool["name"] for tool in await context_mode.list_tools()])
```

## Setup

Install and operate Context Mode separately. When the separately installed
sidecar documents its stdio command, configure the host-managed transport:

```jsonc
{
  "mcpServers": {
    "context-mode": {
      "type": "stdio",
      "command": "context-mode"
    }
  }
}
```

The host launches configured stdio servers lazily and keeps command, args,
environment, and cwd host-side. The Python skill uses the host bridge for
`list_tools` and `call_tool`; it never launches a process itself. If a sidecar's
CLI syntax is not documented, use a safe placeholder such as
`/path/to/separately-installed-mcp-server` rather than guessing flags or
secrets.

Alternatively, configure a streamable HTTP endpoint using
`CONTEXT_MODE_MCP_URL` or Prime Agent settings:

```jsonc
{
  "mcpServers": {
    "context-mode": {
      "type": "http",
      "url": "https://localhost.example/context-mode/mcp",
      "bearerTokenEnvVar": "CONTEXT_MODE_MCP_TOKEN"
    }
  }
}
```

The endpoint and token names are examples, not assumed sidecar defaults. Add
an authorization header through `headers` when required. This skill never
auto-installs, upgrades, reindexes, removes, or purges the sidecar.

## Allowed tools

Discover schemas with `list_tools()` before calling. This skill permits only:

- `ctx_execute(language, code, timeout?, cwd?, intent?)` for bounded derived
  analysis of a command or snippet.
- `ctx_execute_file(path, language, code, timeout?, intent?)` for isolated
  processing of a large source, data file, or log.
- `ctx_batch_execute(...)` for bounded parallel collection followed by immediate
  query extraction.
- `ctx_fetch_and_index(...)`, then `ctx_search(...)`, for large web pages,
  docs, specs, and changelogs.
- `ctx_index(...)`, then `ctx_search(...)`, for caller-supplied content that
  should be available to later bounded searches.

```python
summary = await context_mode.ctx_execute_file(
    path="logs/server.log",
    language="text",
    code="Summarize errors by root cause; return at most ten findings.",
    intent="Find the first recurring production failure."
)

await context_mode.ctx_fetch_and_index(url="https://example.com/release-notes")
notes = await context_mode.ctx_search(queries=["breaking changes", "deprecations"])
```

`ctx_purge`, `ctx_upgrade`, and every other maintenance or autonomous operation
are deliberately blocked. Do not bypass this allowlist, and do not treat this
integration as permission isolation. Review any separately installed sidecar's
license terms; this skill does not include or copy the sidecar.

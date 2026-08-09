---
name: yantrikdb
description: Persistent cross-session memory via a self-hosted YantrikDB MCP server. Semantic recall, remember, belief revision, knowledge graph, contradiction detection, and procedural learning. Tools are auto-discovered from the server at runtime.
---

# YantrikDB

Talk to a self-hosted [YantrikDB](https://github.com/yantrikos/yantrikdb-mcp)
memory server from the IPython kernel. Memory persists across sessions and
across harnesses: what you `remember` here, a future session — or another
agent pointed at the same database — can `recall` by meaning, not phrasing.

## Setup

This integration targets a server the user runs themselves; there is no
hosted endpoint. It enables when `YANTRIKDB_API_KEY` is set and the server
is reachable:

```bash
pip install yantrikdb-mcp
export YANTRIKDB_API_KEY=<token>   # same value in the shell that launches Prime Agent
yantrikdb-mcp --transport streamable-http --host 127.0.0.1 --port 8420
```

The URL defaults to `http://127.0.0.1:8420/mcp`; a `yantrikdb` entry under
`mcpServers` in settings overrides it. If a call raises `NotEnabled`, the
`YANTRIKDB_API_KEY` environment variable is not visible to Prime Agent —
don't ask the user to log in; ask them to set the variable and start the
server.

## Usage

The tool set is defined by the server, not by this skill, so **discover
before you call** — don't assume tool names or argument names:

```python
import yantrikdb

# 1. Discover available tools
for tool in await yantrikdb.list_tools():
    print(tool["name"], "-", tool["description"])

# 2. Inspect a specific tool's arguments (rendered from its JSON Schema)
help(yantrikdb.recall)

# 3. Store a durable fact, then retrieve it by meaning
await yantrikdb.remember(text="User prefers dark mode in the editor", importance=0.7)
hits = await yantrikdb.recall(query="what editor settings does the user like")
print(hits)
```

Notes:
- Every tool is an `async` method — always `await`.
- Results are already-parsed Python (a `dict` for structured output, otherwise a
  string). No need to `json.loads` them.
- When a stored fact changes, prefer the server's `correct` tool over a second
  `remember` — it revises with history instead of creating a contradiction.
- For tools whose names aren't valid Python identifiers, use the escape hatch:
  `await yantrikdb.call_tool("tool-name", {"arg": "value"})`.

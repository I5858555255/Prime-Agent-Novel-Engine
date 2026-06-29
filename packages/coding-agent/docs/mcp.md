# MCP (Model Context Protocol)

Prime Agent ships a first-party [MCP](https://modelcontextprotocol.io) client as a
pi extension. It lets the model call tools hosted by external MCP servers — over
stdio (local subprocess) or streamable HTTP (remote) — without loading every
server's tool schema into the prompt.

The extension lives at `packages/coding-agent/extensions/prime-mcp/` and is
client-only: Prime Agent connects out to MCP servers; it does not expose itself
as an MCP server.

## Why a proxy tool

Loading every tool from every MCP server into the system prompt is expensive —
each tool carries a name, description, and full input schema. Instead, this
extension registers a single `mcp` tool. The model uses it to discover and call
tools on demand:

| Action         | Purpose                                                       |
| -------------- | ------------------------------------------------------------ |
| `list_servers` | List configured servers and their connection state.          |
| `list_tools`   | List a server's tools (name + first description line).       |
| `describe`     | Show one tool's full input schema before calling it.         |
| `call`         | Invoke a tool with an arguments object.                      |

This keeps the always-on context cost to roughly one tool definition regardless
of how many servers or tools are configured.

For a handful of frequently used tools you can opt into `directTools`, which
registers them as ordinary first-class tools (full schema, called directly)
while everything else stays behind the proxy.

## Enabling the extension

The extension is a pi package. Install it from this repo by local path:

```bash
prime-agent install ./packages/coding-agent/extensions/prime-mcp
```

Or add it to `settings.json` under `extensions` / `packages` (see
[packages.md](packages.md)). To try it for a single run without installing:

```bash
prime-agent -e ./packages/coding-agent/extensions/prime-mcp
```

It is not enabled by default in shipped settings.

## Configuration

Servers are declared in `mcp.json`-style files. The shape matches the
`mcpServers` object other MCP clients use, plus two Prime-specific keys.

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${YOUR_TOKEN}" }
    }
  },
  "directTools": ["everything/echo"],
  "idleTimeoutMs": 300000
}
```

A server is **stdio** when it has a `command` (with optional `args`, `env`,
`cwd`) and **http** when it has a `url` (with optional `headers`). A working
template lives in
[`extensions/prime-mcp/mcp.json.example`](../extensions/prime-mcp/mcp.json.example).

### File resolution and precedence

Config is read from these paths, **highest precedence first**:

1. `<cwd>/.mcp.json` — project, the shared convention other tools also read.
2. `<cwd>/.prime/agent/mcp.json` — project, Prime-specific.
3. `~/.prime/agent/mcp.json` — global, applies to every project.

All existing files are merged. Lower-precedence files are applied first, so a
higher-precedence file overrides a server with the same name. `directTools` are
unioned across files; `idleTimeoutMs` from the highest-precedence file that sets
it wins. A file that cannot be read or parsed is skipped with a warning (shown
in `/mcp status`) rather than disabling the others.

A `directTools` entry is only honored when the config file that declared it is
also the one that won the referenced server's definition. This prevents a
lower-trust file (a repo `.mcp.json`) from redefining a server name that a
higher-trust file (`~/.prime/agent/mcp.json`) opted to auto-promote, which would
otherwise spawn an unexpected command at startup. Define a server and its
`directTools` in the same file.

Config is read **once**, from the working directory of the first session in the
process. Promoted `directTools` register as global tools and cannot be
unregistered, so applying config changes (new servers, changed `directTools`)
requires restarting Prime Agent.

### Keys

- `mcpServers` — map of server name to stdio or http config.
- `directTools` — array of `"server/tool"` references to promote to first-class
  tools. Unknown servers or tools are logged and skipped.
- `idleTimeoutMs` — disconnect a server after this many ms of inactivity
  (default `300000`). Set to `0` to keep connections open.

`${VAR}` references in HTTP `headers` values and stdio `env` values are expanded
from the environment when the server is started, so you can keep secrets out of
committed config files (a missing variable expands to an empty string).

## Connection lifecycle

- **Lazy connect.** A server is only started on first use (`list_tools`,
  `describe`, `call`, or a `directTools` promotion at startup).
- **Idle disconnect.** Connections close after `idleTimeoutMs` of inactivity and
  reconnect transparently on next use.
- **Reconnect on failure.** If an operation fails on a dead transport, the
  extension drops the connection and retries once before surfacing the error.
- **Shutdown.** All connections close on `session_shutdown`. HTTP sessions are
  terminated server-side on a best-effort basis with a short timeout, so a
  server that doesn't support explicit termination — or stops responding to it —
  can't stall shutdown; the client is closed regardless.

Tool result content is passed through in order: text and images (including
images embedded in `resource` blocks) reach the model as text and image content.
`resource_link` blocks and non-image embedded resources are rendered as text
summaries (uri, name, and any inline text), not as separate attachments.

## The `/mcp` command

| Command                  | What it does                                         |
| ------------------------ | --------------------------------------------------- |
| `/mcp status`            | Show each server's connection state and tool count.  |
| `/mcp tools <server>`    | List a server's tools (connects if needed).          |
| `/mcp reconnect [server]`| Reconnect one server, or all if none is given.       |
| `/mcp setup`             | Print config file locations and an example.          |

## Security

MCP servers run with your permissions: stdio servers spawn local processes,
HTTP servers receive whatever you put in `headers`. Only configure servers you
trust, and prefer environment-variable references over hard-coded secrets in
committed `.mcp.json` files.

In the prime-swarm model, MCP is agent-to-tool: the tool implementation ships in
the agent image and only tool *names* cross the swarm wire. Which MCP servers an
agent reaches is governed by the swarm's `egress` and `credentials` controls, not
by any interconnect machinery. See prime-swarm `docs/interconnect.md`.

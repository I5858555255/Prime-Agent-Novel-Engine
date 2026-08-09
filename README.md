<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9cb3-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent: A Self-Improving RLM Agent
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

Prime Agent is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Prime Agent can refine through small, evidence-backed updates, local to the session by default.

Prime Agent combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** persistent IPython is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

Install the latest stable release on macOS or Linux:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

The installer downloads a versioned release, verifies its SHA-256 checksum, installs the `prime-agent` command, and can prepare the IPython runtime used by the agent.

Start Prime Agent from the repository or directory you want it to work in:

```bash
cd /path/to/project
prime-agent
```

On first launch, run `/login` to choose a subscription or API-key provider. Prime Agent works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Prime Agent executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
prime-agent agents                   # Browse running, idle, and saved sessions
prime-agent attach <agent>           # Reattach to a running session
prime-agent --resume <path|id>       # Resume a saved session
prime-agent status                   # Inspect background service state
prime-agent doctor [--fix]           # Inspect or repair background services
prime-agent update [--force]         # Update Prime Agent
prime-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Context-Efficient Tools in This Fork

This fork adds context-efficient retrieval and output handling without changing Prime Agent's single-tool model. The model still receives `ipython`; the extra capabilities are Python skills called from the persistent kernel. For local MCP integrations, the call path is:

```text
IPython → Python skill → host bridge → lazy stdio MCP sidecar
```

The host owns each sidecar's command, environment, working directory, startup, serialization, restart, and shutdown. Process settings and secrets are not copied into the kernel. A timed-out tool call that may already have reached a server is not automatically retried; the tainted sidecar is cleaned up before another call is dispatched.

### jCodeMunch: structured code retrieval

`jcodemunch` retrieves symbols and focused code context instead of loading whole repositories into the model's context. Use it to find definitions, inspect outlines and exact implementations, trace references/importers, assemble ranked context, or estimate a refactor's blast radius.

```python
import jcodemunch

status = await jcodemunch.available()
if status["configured"]:
    tools = await jcodemunch.list_tools()  # The server owns the schemas
    hits = await jcodemunch.search_symbols(
        repo="prime-agent", query="McpIntegration", detail_level="compact"
    )
    source = await jcodemunch.get_symbol_source(
        repo="prime-agent", symbol_id=hits[0]["symbol_id"], verify=True
    )
```

The Python skill is bundled, but the `jcodemunch-mcp` sidecar is separate and optional. Importing the skill never installs, indexes, upgrades, or purges it. When the command is unavailable, `available()` returns a diagnostic and the agent can fall back to normal file inspection.

### Context Mode: bounded large-output processing

`context_mode` is for large logs, documents, web pages, and command output where a small derived result is more useful than raw content. It can process a file in isolation, execute bounded analysis, batch commands, or index and search fetched content.

```python
import context_mode

summary = await context_mode.ctx_execute_file(
    path="logs/server.log",
    language="python",
    code=(
        "errors=[line for line in FILE_CONTENT.splitlines() if 'ERROR' in line]; "
        "print(len(errors)); print('\n'.join(errors[:10]))"
    ),
    intent="Find the first recurring production failure.",
)
```

The bundled skill exposes only collection, execution, indexing, and search operations; maintenance operations such as upgrade and purge are blocked. The separately installed `context-mode` sidecar still runs with its own filesystem and network permissions. Context Mode limits what enters the model context; it is not a security sandbox.

Both sidecars default to lazy host-managed stdio when their commands are installed. Override the command, environment, working directory, tool filters, or transport under `mcpServers`, or disable one explicitly:

```jsonc
{
  "mcpServers": {
    "jcodemunch": {
      "type": "stdio",
      "command": "/path/to/jcodemunch-mcp"
    },
    "context-mode": {
      "type": "stdio",
      "command": "context-mode",
      "enabled": false
    }
  }
}
```

Both skills can also connect to a configured streamable HTTP MCP endpoint. See the [MCP integration guide](packages/coding-agent/docs/mcp-integrations.md#optional-local-sidecars) for transport, authentication, and tool-filter settings.

### Bounded IPython output artifacts

Large IPython stdout, stderr, results, and tracebacks are automatically materialized as artifacts instead of being injected wholesale into the conversation. Prime Agent returns a bounded preview plus an opaque handle. The agent can then page or search only the relevant channel:

```python
import rlm

page = await rlm.host_request(
    "artifact.read",
    {"handle": "artifact_…", "channel": "stdout", "offset": 0, "max_chars": 4000},
)
matches = await rlm.host_request(
    "artifact.search",
    {"handle": "artifact_…", "channel": "stdout", "query": "ERROR"},
)
```

Artifacts use bounded previews, chunked search, sparse seek checkpoints, atomic publication, and code-point-safe boundaries. Failed or cancelled executions dispose temporary captures rather than leaving open files behind.

### Optional context-routing policy

The example context-routing extension can steer broad reads toward these tools:

```bash
prime-agent \
  -e ./packages/coding-agent/examples/extensions/context-routing.ts \
  --context-routing advisory

# Block high-confidence large raw reads instead of only advising:
prime-agent \
  -e ./packages/coding-agent/examples/extensions/context-routing.ts \
  --context-routing strict-large-read
```

`advisory` recommends jCodeMunch for source retrieval and Context Mode for large documents or logs. `strict-large-read` additionally blocks high-confidence raw `cat`/download output and directly printed unbounded Python file reads while allowing bounded reads, scalar reductions, builds, tests, git commands, and writes. It is a routing policy, not a security control; see the [extension documentation](packages/coding-agent/examples/extensions/context-routing.md) for its bypass marker, limitations, and optional fast reindex behavior.

## Built for Long-Running Work
Prime Agent is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously. 

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, IPython state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `prime-agent schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — persistent IPython, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Prime Agent is fully open source and released under the [MIT License](LICENSE).

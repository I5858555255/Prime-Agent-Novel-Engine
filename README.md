<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9b3-f7b902cd155d">
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
    <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
  </picture>
</p>

---

<h3 align="center">
Prime Agent: RLM-native Coding and Research Harness
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="packages/coding-agent/docs/kernel-and-rlm-recursion.md">Kernel and RLM Recursion</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a>
</p>

---

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

## Overview

Prime Agent is a fork of [pi-mono](https://github.com/badlogic/pi-mono) rebuilt around an RLM-native coding and research workflow. The TypeScript host keeps pi's terminal UI, provider layer, session tree, slash commands, and extension system. The model-facing runtime is centered on a persistent IPython kernel with recursive subagents exposed through a small `rlm` API.

Prime Agent is designed for workflows where the model should work inside a durable Python state, compose tools through code, and delegate independent subtasks to child agents without leaving the same harness.

What sets it apart:

1. Persistent IPython execution as the primary model tool.
2. Recursive child agents through `await rlm("subtask")` and normal Python async patterns.
3. Live terminal UI for messages, IPython cells, session history, and child-agent state.
4. Shared provider and auth stack for API-key providers, subscription providers, custom models, and OAuth flows.
5. Python skill surface for Prime workflows such as environments, evals, training, and analysis.
6. JSONL session storage with branching, resume, fork, clone, export, and compaction support.

## Getting Started

Prime Agent runs as the `pi` CLI in installed builds. From this repository, use the source runner:

```bash
npm ci
./pi-test.sh
```

Authenticate in the TUI with:

```text
/login
```

Or launch with an API key in the environment:

```bash
ANTHROPIC_API_KEY=sk-ant-... ./pi-test.sh
OPENAI_API_KEY=sk-... ./pi-test.sh
```

Start in a repository and ask for work:

```bash
cd /path/to/project
/path/to/prime-agent/pi-test.sh "Summarize this codebase and tell me how to run its checks."
```

For one-shot prompts, use print mode:

```bash
./pi-test.sh -p "List the package layout and main entrypoints."
./pi-test.sh -p @README.md "Summarize this README."
```

By default, the model gets the `ipython` tool. Additional built-in tools, including `bash` and `edit`, can be enabled explicitly:

```bash
./pi-test.sh --tools ipython,bash,edit
```

## Kernel Runtime

The IPython kernel is bootstrapped automatically on first use. Prime Agent resolves Python in this order:

1. `PRIME_AGENT_KERNEL_PYTHON`, if set and able to import `ipykernel` and the current `rlm` runtime.
2. `~/.prime/agent/kernel-venv/bin/python`, created automatically when needed.
3. `$XDG_DATA_HOME/prime/agent/kernel-venv/bin/python`, when the home config directory is not writable.

To bootstrap the kernel environment manually:

```bash
./scripts/setup-kernel-venv.sh
```

The kernel keeps Python variables, imports, loaded data, helper functions, stdout history, and async task handles alive across turns in the same agent session.

## RLM Recursion

The `prime-agent-runtime` package installs a tiny Python module named `rlm` into the kernel environment. It preserves the model-facing RLM API while delegating actual child-agent execution to the TypeScript host.

Inside an IPython cell, the model can run:

```python
result = await rlm("inspect the test layout and report the most important files")
print(result.answer)
print(result.usage.total)
```

Parallel child agents use ordinary Python async code:

```python
results = await asyncio.gather(
    rlm("find the main CLI entrypoint"),
    rlm("inspect the provider registry"),
    rlm("summarize the kernel bootstrap path"),
)
print([result.answer for result in results])
```

Each child gets its own `AgentSession`, kernel, session directory, model settings, tools, and skills. The parent receives an `RLMResult` with:

- `answer`: the final assistant text from the child.
- `usage`: token usage for the child session.
- `turns`: number of assistant turns in the child.
- `session_dir`: the persisted child session directory when available.

The default recursion depth is one child level. See [Kernel and RLM Recursion](packages/coding-agent/docs/kernel-and-rlm-recursion.md) for the transport details, depth checks, session layout, comm handling, and validation commands.

## Architecture

```text
                         +----------------------+
                         |     prime-agent      |
                         |     TypeScript CLI   |
                         +----------+-----------+
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
        v                           v                           v
+---------------+           +---------------+           +---------------+
|    pi-tui     |           | AgentSession  |           |    pi-ai      |
| terminal UI   |           | loop + events |           | model clients |
+-------+-------+           +-------+-------+           +-------+-------+
        |                           |                           |
        |                           |                           v
        |                           |                  +----------------+
        |                           |                  | selected LLM   |
        |                           |                  | or bootstrap   |
        |                           |                  +----------------+
        |                           |
        v                           v
+---------------+           +---------------+
| IPython cells |           | JSONL session |
| subagent pane |           | tree + resume |
+---------------+           +---------------+

                            prime agent adds
                                    |
                                    v
                         +----------------------+
                         |     ipython tool     |
                         +----------+-----------+
                                    |
                              Jupyter ZMQ
                                    |
                                    v
                         +----------------------+
                         |   IPython kernel     |
                         | persistent Python    |
                         | state across turns   |
                         +----------+-----------+
                                    |
                 +------------------+------------------+
                 |                                     |
                 v                                     v
        +------------------+                 +------------------+
        | prime-agent-     |                 | Python skills    |
        | runtime          |                 | envs/eval/train  |
        | injects rlm      |                 | and analysis     |
        +--------+---------+                 +------------------+
                 |
                 | await rlm("subtask")
                 v
        +------------------+
        | child agent      |
        | session + kernel |
        +------------------+
```

The core loop is:

1. The model receives the chat turn plus the RLM-oriented system prompt.
2. Tool use goes through `ipython`, which executes in a persistent IPython kernel.
3. The kernel keeps state across turns.
4. The injected `rlm` callable can spawn child agents, including parallel children through `asyncio.gather`.
5. Each child uses the same TypeScript agent/session machinery and returns an `RLMResult` to the parent kernel.
6. The TUI renders kernel cells, messages, session history, and child-agent state while preserving JSONL history on disk.

## Repository Layout

```text
packages/
  ai/             Unified model/provider abstraction
  agent/          Agent loop, messages, events, and tool execution
  tui/            Terminal UI renderer and components
  coding-agent/   CLI, interactive mode, sessions, tools, docs, examples
  web-ui/         Reusable browser chat UI components

prime-agent-runtime/
  src/rlm/        Kernel-side Python shim for rlm.run recursion

scripts/
  setup-kernel-venv.sh       Manual kernel bootstrap wrapper
  profile-coding-agent-node.mjs
  session-transcripts.ts
```

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) - install, authenticate, and start a first session.
- [Using Pi](packages/coding-agent/docs/usage.md) - interactive mode, slash commands, files, context, and CLI reference.
- [Providers](packages/coding-agent/docs/providers.md) - model providers, API keys, OAuth, and custom endpoints.
- [Kernel and RLM Recursion](packages/coding-agent/docs/kernel-and-rlm-recursion.md) - IPython transport and recursive child-agent execution.
- [Sessions](packages/coding-agent/docs/sessions.md) - resume, branch, fork, clone, and compact session history.
- [Extensions](packages/coding-agent/docs/extensions.md) - TypeScript hooks for tools, commands, events, and UI.
- [Skills](packages/coding-agent/docs/skills.md) - reusable model capabilities loaded from local or package skill directories.
- [SDK](packages/coding-agent/docs/sdk.md) and [RPC mode](packages/coding-agent/docs/rpc.md) - embed or integrate Prime Agent from other processes.

## Development

Install dependencies from the lock file:

```bash
npm ci
```

Run the CLI from source:

```bash
./pi-test.sh
```

Useful checks:

```bash
npm run check
```

The CI workflow runs dependency installation, build, checks, and tests on pull requests and pushes to `main`. See [Development](packages/coding-agent/docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for repository workflow details.

## Related Projects

- [Verifiers](https://github.com/PrimeIntellect-ai/verifiers) - environments for LLM reinforcement learning.
- [PRIME-RL](https://github.com/PrimeIntellect-ai/prime-rl) - asynchronous RL training at scale.
- [pi](https://github.com/badlogic/pi-mono) - upstream terminal coding harness.

## License

MIT

<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9b34-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent: RLM-native Coding and Research Harness
</h3>

<p align="center">
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

## Overview

Prime Agent is an RLM-native coding and research harness.

The model-facing runtime is centered on a persistent IPython kernel with recursive subagents exposed through a small `rlm` API. The TypeScript host owns model calls, tools, sessions, scheduling, and child-agent execution while Python provides a durable control environment for composing that functionality.

Prime Agent is designed for workflows where the model should work inside a durable Python state, compose tools through code, and delegate independent subtasks to child agents without leaving the same harness.

## Core Features

### Programmatic RLM

Prime Agent's default RLM runtime exposes one built-in model tool: a persistent IPython kernel. File operations, project commands, context management, skills, and delegation are composed as code instead of separate tool calls. [Learn about the RLM programming model](packages/coding-agent/docs/rlm.md).

### Native Subagents

Subagents are part of the RLM runtime and are created programmatically with `await rlm("subtask")`. Normal Python async patterns provide parallel and background delegation, while each child receives an independent Prime Agent session and context.

### Python-Backed Skills

Prime Agent extends markdown skills with installable Python packages. Python-backed skills keep `SKILL.md` for discovery and instructions, add callable functionality to the kernel, and can themselves use RLM delegation. [Learn how skills work and how to create one](packages/coding-agent/docs/skills.md).

### Background Agents and Messaging

Interactive sessions run in daemon-backed workers, so closing the terminal UI detaches without stopping the agent. Active agents and retained subagents can exchange direct messages through the CLI or the kernel-side `agent_message` skill.

### Long-Running Work

Automatic compaction, persistent goals, recurring heartbeats, scheduled prompts, quality-gated autonomous mode, and retained subagents let work continue across turns and terminal sessions. [Learn about long-running and background agents](packages/coding-agent/docs/long-running-agents.md).

## Getting Started

Install the latest stable release:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

Install the latest beta built from `main`:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install-beta.sh | sh
```

Stable advances when a version bump lands on `main`; beta advances on every commit to `main`.

Then start Prime Agent:

```bash
prime-agent
```

Alternatively, to test local changes, clone this repository and use the source runner:

```bash
npm ci
./prime-agent.sh
```

Authenticate in the TUI with:

```text
/login
```

Public releases are currently installed from versioned release artifacts through these installer scripts. The repository still contains inherited npm workspace identifiers for source compatibility; they are not the user-facing Prime Agent install path.

## Common Commands

```bash
prime-agent                          # Start a new session
prime-agent agents                   # Open the agents view
prime-agent --resume [path|id]       # Browse or resume a previous session
prime-agent doctor [--fix]           # Inspect or repair background services
prime-agent update [--force]         # Update Prime Agent
prime-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [RLM programming model](packages/coding-agent/docs/rlm.md)
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md)
- [Usage and CLI reference](packages/coding-agent/docs/usage.md)
- [Provider setup](packages/coding-agent/docs/providers.md)
- [Development](packages/coding-agent/docs/development.md)

## Upstream and License

Prime Agent is licensed under the MIT License. The root [LICENSE](LICENSE) preserves attribution for pi-mono by Mario Zechner and identifies Prime Intellect's subsequent work.

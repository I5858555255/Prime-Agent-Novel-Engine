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

Prime Agent is a fork of [pi-mono](https://github.com/badlogic/pi-mono) rebuilt around an RLM-native coding and research workflow. The TypeScript host keeps the original terminal UI, provider layer, session tree, slash commands, and extension system. The model-facing runtime is centered on a persistent IPython kernel with recursive subagents exposed through a small `rlm` API.

Prime Agent is designed for workflows where the model should work inside a durable Python state, compose tools through code, and delegate independent subtasks to child agents without leaving the same harness. It is useful for repository work, research tasks, long-running investigations, data inspection, and any task where the assistant benefits from maintaining variables, helper functions, logs, and subprocess state across multiple turns.

Unlike a typical coding agent that receives a narrow set of one-shot tools, Prime Agent treats code execution as the model's control plane. The assistant can use Python to read and transform files, call project-native commands, parse outputs, coordinate background work, and launch recursive child agents for isolated subtasks. The terminal UI keeps those steps visible so users can inspect messages, IPython cells, tool output, and subagent progress in one session.

What sets it apart:

1. Persistent IPython execution as the primary model tool, so imports, variables, helper functions, and analysis artifacts survive across turns.
2. Recursive child agents through `await rlm("subtask")` and normal Python async patterns, enabling parallel research or code-inspection work without leaving the parent session.
3. Live terminal UI for messages, IPython cells, session history, and child-agent state, including controls for resuming, branching, compacting, and exporting sessions.
4. Shared provider and auth stack for API-key providers, subscription providers, custom models, and OAuth flows.
5. Python skill surface for Prime workflows such as environments, evals, training, hosted inference, and analysis.
6. JSONL session storage with branching, resume, fork, clone, export, and compaction support.

## How Prime Agent Works

A Prime Agent session has two cooperating parts:

- The TypeScript host renders the terminal interface, manages sessions, stores authentication, resolves models, and exposes commands such as `/login`, `/model`, `/resume`, `/compact`, and `/share`.
- The model-facing runtime runs through IPython. The assistant uses the kernel as a durable scratchpad and automation environment instead of treating each shell command or file read as an isolated action.

This design encourages the assistant to break tasks into small steps, inspect real repository state before making claims, keep intermediate data in Python, and run project commands through the repository's own tooling. When a subtask can be handled independently, the assistant can call `rlm` from IPython to spawn a child agent and continue other work while the child agent investigates.

## Getting Started

Install the latest stable release:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

Then start Prime Agent:

```bash
prime-agent
```

Authenticate in the TUI with:

```text
/login
```

Use `/login` to connect a subscription provider such as Claude, ChatGPT/Codex, or GitHub Copilot, or to save API-key credentials for supported providers. You can also provide keys with environment variables before launching the app, for example:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

After authentication, use `/model` to choose a model and start chatting. Prime Agent will give the assistant access to the persistent `ipython` tool by default. The assistant can use that tool to inspect the repository, run commands, edit files, and coordinate longer investigations.

To test local changes, clone this repository and use the source runner:

```bash
npm ci
./prime-agent.sh
```

The Python kernel runtime is set up automatically on first invocation. Set `PRIME_AGENT_KERNEL_PYTHON` to use an existing Python environment with `ipykernel`.

## Example Workflows

Prime Agent is built for interactive, inspect-first workflows. Examples include:

- Ask it to investigate a bug, reproduce the failure with project-native commands, patch the implementation, and summarize the verification it ran.
- Ask it to read a large code path and explain the architecture while keeping notes and cross-references in the persistent Python kernel.
- Ask it to fan out independent research or code-search subtasks through child agents and integrate the conclusions into one final answer.
- Ask it to analyze logs, benchmark output, CSV files, JSONL traces, or other structured data using Python libraries inside the session.
- Ask it to prepare a branch for review while preserving the full message, tool-call, and session history for later resume or export.

## Authentication and Models

Prime Agent supports both subscription login flows and API-key based providers. Built-in authentication covers providers such as Anthropic, OpenAI, GitHub Copilot, Prime Inference, Azure OpenAI, DeepSeek, Google Gemini, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, OpenRouter, Vercel AI Gateway, xAI, and others documented in the package guides.

Common commands:

- `/login` stores credentials or starts an OAuth/device login flow.
- `/logout` clears stored credentials for a provider.
- `/model` opens the model selector.
- `/settings` adjusts runtime and UI preferences.
- `/usage` shows token, cost, and context details.
- `/resume`, `/tree`, `/fork`, and `/clone` navigate saved session history.
- `/compact` summarizes long contexts so work can continue in the same thread.

Credentials are stored under the Prime Agent configuration directory. See the package documentation for the full provider matrix, environment variables, and custom model configuration.

## Repository and Package Docs

This repository contains the terminal application, the shared AI/provider package, the agent runtime pieces, and supporting scripts. The most useful package-level entry points are:

- `packages/coding-agent/README.md` for the CLI, TUI commands, sessions, settings, skills, extensions, and operational usage.
- `packages/coding-agent/docs/providers.md` for provider setup and authentication details.
- `packages/coding-agent/docs/models.md` for model configuration.
- `packages/ai/README.md` for the provider abstraction and programmatic AI package usage.

For local development, install dependencies with `npm ci`, use `./prime-agent.sh` to run from source, and run the repository checks configured in `package.json` before submitting code changes.

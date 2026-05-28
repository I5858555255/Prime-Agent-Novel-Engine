<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/brand/prime-butterfly.svg">
      <img alt="Prime Intellect butterfly mark" src="assets/brand/prime-butterfly-black.svg" width="112">
    </picture>
  </a>
</p>

<h1 align="center">Prime Agent</h1>

<p align="center">
  <strong>RLM-native coding harness</strong>
</p>

---

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

Prime Agent is designed for workflows where the model should work inside a durable Python state, compose tools through code, and delegate independent subtasks to child agents without leaving the same harness.

What sets it apart:

1. Persistent IPython execution as the primary model tool.
2. Recursive child agents through `await rlm("subtask")` and normal Python async patterns.
3. Live terminal UI for messages, IPython cells, session history, and child-agent state.
4. Shared provider and auth stack for API-key providers, subscription providers, custom models, and OAuth flows.
5. Python skill surface for Prime workflows such as environments, evals, training, and analysis.
6. JSONL session storage with branching, resume, fork, clone, export, and compaction support.

## Getting Started

Install the latest stable release:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

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

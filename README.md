<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9b34-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="PRIME INTELLECT" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
PRIME AGENT: RLM-NATIVE CODING AND RESEARCH HARNESS
</h3>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/verifiers">VERIFIERS</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">PI-MONO</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="BUILD BINARIES" />
  </a>
</p>

## OVERVIEW

PRIME AGENT IS A FORK OF [PI-MONO](https://github.com/badlogic/pi-mono) REBUILT AROUND AN RLM-NATIVE CODING AND RESEARCH WORKFLOW. THE TYPESCRIPT HOST KEEPS THE ORIGINAL TERMINAL UI, PROVIDER LAYER, SESSION TREE, SLASH COMMANDS, AND EXTENSION SYSTEM. THE MODEL-FACING RUNTIME IS CENTERED ON A PERSISTENT IPYTHON KERNEL WITH RECURSIVE SUBAGENTS EXPOSED THROUGH A SMALL `rlm` API.

PRIME AGENT IS DESIGNED FOR WORKFLOWS WHERE THE MODEL SHOULD WORK INSIDE A DURABLE PYTHON STATE, COMPOSE TOOLS THROUGH CODE, AND DELEGATE INDEPENDENT SUBTASKS TO CHILD AGENTS WITHOUT LEAVING THE SAME HARNESS.

WHAT SETS IT APART:

1. PERSISTENT IPYTHON EXECUTION AS THE PRIMARY MODEL TOOL.
2. RECURSIVE CHILD AGENTS THROUGH `await rlm("subtask")` AND NORMAL PYTHON ASYNC PATTERNS.
3. LIVE TERMINAL UI FOR MESSAGES, IPYTHON CELLS, SESSION HISTORY, AND CHILD-AGENT STATE.
4. SHARED PROVIDER AND AUTH STACK FOR API-KEY PROVIDERS, SUBSCRIPTION PROVIDERS, CUSTOM MODELS, AND OAUTH FLOWS.
5. PYTHON SKILL SURFACE FOR PRIME WORKFLOWS SUCH AS ENVIRONMENTS, EVALS, TRAINING, AND ANALYSIS.
6. JSONL SESSION STORAGE WITH BRANCHING, RESUME, FORK, CLONE, EXPORT, AND COMPACTION SUPPORT.

## GETTING STARTED

INSTALL THE LATEST STABLE RELEASE:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

THEN START PRIME AGENT:

```bash
prime-agent
```

ALTERNATIVELY, TO TEST LOCAL CHANGES, CLONE THIS REPOSITORY AND USE THE SOURCE RUNNER:

```bash
npm ci
./prime-agent.sh
```

AUTHENTICATE IN THE TUI WITH:

```text
/login
```

## COMMON COMMANDS

```bash
prime-agent                          # START A NEW SESSION
prime-agent agents                   # OPEN THE AGENTS VIEW
prime-agent --resume [path|id]       # BROWSE OR RESUME A PREVIOUS SESSION
prime-agent doctor [--fix]           # INSPECT OR REPAIR BACKGROUND SERVICES
prime-agent update [--force]         # UPDATE PRIME AGENT
prime-agent shutdown [--force]       # STOP EVERY AGENT, WORKER, AND BACKGROUND SERVICE
```

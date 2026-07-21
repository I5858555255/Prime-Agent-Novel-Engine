# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Prime Agent requires Node.js 22.8.0 or newer.

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
```

Run from source:

```bash
/path/to/prime-agent/prime-agent.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

Prime Agent is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-prime-agent-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public Prime Agent install path.

## Local Configuration

User configuration lives under `~/.prime/agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.prime/agent/` in the project root. Override the user config directory with `PRIME_AGENT_CODING_AGENT_DIR` and the session directory with `PRIME_AGENT_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
PRIME_AGENT_CODING_AGENT_DIR=/tmp/prime-agent-dev /path/to/prime-agent/prime-agent.sh
```

## Architecture

Start with the [architecture overview](architecture.md). It describes the package graph, process ownership, prompt execution, session storage, and trust boundaries. The main implementation references are:

- [Daemon and Session Worker Architecture](daemon-implementation-summary.md) for the supervisor, catalog subprocess, resident workers, client-owned workers, recovery, and protocol.
- [AgentConnection Architecture](agent-connection-readme.md) for the boundary between clients and session runtimes.
- [Kernel and RLM Recursion](kernel-and-rlm-recursion.md) for the ZeroMQ Jupyter transport, Python host bridge, and TypeScript-owned child agents.

At runtime, the foreground CLI connects to a local supervisor. A worker process owns one root `AgentSessionRuntime`, its session tree, IPython kernel, schedules, and all RLM descendants. The kernel-side `rlm` package is a shim: child agent loops execute in the TypeScript host through normal `AgentSession` machinery.

## Project Structure

```text
packages/
  ai/             LLM provider abstraction, model catalog, and message conversion
  agent/          Provider-independent agent loop and message types
  tui/            Terminal rendering and input components
  coding-agent/   CLI, daemon, workers, sessions, IPython bridge, skills, and extensions

prime-agent-runtime/
  src/rlm/        Python package installed into the persistent kernel environment

scripts/          Release, installer, generation, and profiling utilities
```

The main coding-agent runtime areas are:

```text
packages/coding-agent/src/
  cli/                     Public command routing and daemon launch
  modes/daemon/            Supervisor, catalog, worker protocol, and recovery
  modes/agent-connection/  Client/runtime adapters
  modes/interactive/       Interactive TUI orchestration
  core/agent-session.ts    Session runtime and parent/child lifecycle
  core/kernel/             Jupyter ZeroMQ transport and host requests
  core/tools/ipython.ts    Model-facing IPython tool
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

Prime Agent runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

## Debugging

The hidden `/debug` command writes `~/.prime/agent/prime-agent-debug.log` with rendered TUI lines, their visible widths, and the current agent messages. Daemon, worker, client, and provider diagnostic logs live under `~/.prime/agent/logs/`.

Useful service commands:

```bash
prime-agent status
prime-agent doctor
prime-agent doctor --fix
prime-agent shutdown
```

## Validation

After code changes, run the repository check from the root:

```bash
npm run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.

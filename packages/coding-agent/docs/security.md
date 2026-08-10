# Security and Sandboxing

Prime Agent runs model-generated Python and project commands directly on your machine. This page separates what Prime Agent itself enforces from what you, as the operator, need to isolate yourself, especially for unattended or long-running sessions.

## Trust Model

Assume generated commands may be unsafe, or influenced by untrusted repository content, skills, or extensions. The agent should be treated as an automated shell user with whatever permissions it is given.

The persistent IPython kernel that executes commands is a durable *control* environment, not a security sandbox. Worker and kernel processes give you lifecycle isolation and recovery (crash resilience, clean restarts), not a restriction on what the agent can read, write, or execute. This applies equally to direct shell commands, Python-backed skills, MCP-backed skills, and subagents spawned with `rlm(...)` (which inherit the parent's permissions).

## Recommended Isolation

- Run in a disposable container or VM, not directly on your host.
- Mount only the target workspace — not `$HOME`, cloud provider config, SSH keys, or browser profiles.
- Use a non-root user inside the container, and avoid mounting the Docker socket.
- Keep secrets out of the environment and out of any mounted config; use short-lived, read-only credentials where the task allows it.

## Workspace Boundaries

- Point the agent at a scratch clone or branch, not your primary checkout.
- Avoid running against a repo with uncommitted local changes — a clean baseline makes it easy to tell what the agent actually did.
- Review generated diffs before merging or pushing.
- For one-off, disposable runs where you don't need persistence, use `--no-session`.

## Tool and Command Restrictions

Prime Agent does not currently have a built-in mechanism for command approval, tool disabling, or path/command allowlists. If your workflow needs those guarantees, enforce them at the OS or container level (see Recommended Isolation above) rather than assuming Prime Agent will gate risky commands for you.

Before loading any third-party skill, extension, or package (via `skills`, `extensions`, or `packages` in `settings.json`), read it. Once installed, it runs with the same kernel permissions as everything else. The same goes for repo-provided instructions (`AGENTS.md`, `CLAUDE.md`, etc.) and subagent output: a repo or a child agent's output can carry prompt-injected instructions or copied secrets, so treat both as untrusted input worth a look before acting on them further.

## Persisted State

Two things persist across runs by default:

- **Session history**, written as append-only JSONL under `sessionDir` (default `.prime/agent/sessions`, configurable in `settings.json`). It can contain paths, command output, and other details from the session. There's no dedicated clear command today: to reset, delete the relevant session file or directory directly, or use `--no-session` to skip creating one in the first place.
- **Stored credentials**, written to `~/.prime/agent/auth.json` (created with 0600 permissions) after `/login` or when an API key is configured this way. This lives outside `sessionDir` and isn't affected by `--no-session`.

Treat both like any other artifact of the run, not just the obvious command output.

## Pre-Run Checklist

- [ ] Disposable container/VM or dedicated non-root user, not your primary host account
- [ ] Only the target repository is writable; no `$HOME`, credentials, or SSH keys mounted
- [ ] Secrets are not present in the environment or mounted config
- [ ] Network access is restricted if the task doesn't need it
- [ ] Working from a clean baseline (scratch clone/branch, no uncommitted changes)
- [ ] Any skills, extensions, packages, or `AGENTS.md`/`CLAUDE.md` instructions have been read, not just installed
- [ ] Generated diffs/output will be reviewed before merging, pushing, or acting on them further
- [ ] For autonomous/long-running sessions specifically: a real, verifiable stopping condition is in place, not just a time or turn budget

## See Also

- [RLM Programming Model](./rlm.md) — the Trust Model section covers the kernel's permission model in more detail
- [Long-Running and Background Agents](./long-running-agents.md) — autonomous mode, heartbeats, and schedules
- [Settings](./settings.md) — `sessionDir` and resource-loading configuration
- [Architecture Overview](./architecture.md) — daemon, worker, and kernel process boundaries
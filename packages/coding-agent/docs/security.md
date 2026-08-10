# Security and Sandboxing

Prime Agent runs model-generated Python and project commands directly on your machine. This page separates what Prime Agent itself enforces from what you, as the operator, need to isolate yourself, especially for unattended or long-running sessions.

## Trust Model

Assume generated commands may be unsafe, or influenced by untrusted repository content, skills, or extensions. The agent should be treated as an automated shell user with whatever permissions it is given.

Prime Agent does not currently provide a full security sandbox. Treat commands executed by the agent as if they were executed by your own user account. Use container/VM isolation, restricted mounts, and minimal credentials for unattended runs.

The persistent IPython kernel that executes commands is a durable *control* environment for lifecycle isolation and recovery (crash resilience, clean restarts), not a permission boundary. This applies equally to direct shell commands, Python-backed skills, MCP-backed skills, and subagents spawned with `rlm(...)` (which inherit the parent's permissions).

## Recommended Isolation

- Run in a disposable container or VM, not directly on your host.
- Mount only the target workspace, not `$HOME`, cloud provider config, SSH keys, or browser profiles.
- Use a non-root user inside the container, and avoid mounting the Docker socket.
- Keep secrets out of the environment and out of any mounted config; use short-lived, read-only credentials where the task allows it.

A minimal starting point:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --network none \
  -v "$PWD/scratch-repo:/workspace" \
  -w /workspace \
  <agent-image> \
  --no-session
```

`--network none` is a safe default but will break workflows that need package installs or API calls; relax it deliberately (e.g. an allowlisted proxy) rather than dropping it by default.

## Workspace Boundaries

- Point the agent at a scratch clone or branch, not your primary checkout.
- Avoid running against a repo with uncommitted local changes; a clean baseline makes it easy to tell what the agent actually did.
- Make sure the clone's remote doesn't carry push credentials, and don't forward your SSH agent into the run.
- Review generated diffs before merging or pushing.

## Tool and Command Restrictions

Prime Agent does not currently have a built-in mechanism for command approval, tool disabling, or path/command allowlists. If your workflow needs those guarantees, enforce them at the OS or container level (see Recommended Isolation above) rather than assuming Prime Agent will gate risky commands for you.

Before loading any third-party skill, extension, or package (via `skills`, `extensions`, or `packages` in `settings.json`), read it. Once installed, it runs with the same kernel permissions as everything else. The same goes for repo-provided instructions (`AGENTS.md`, `CLAUDE.md`, etc.) and subagent output: a repo or a child agent's output can carry prompt-injected instructions or copied secrets, so treat both as untrusted input worth a look before acting on them further.

## Persisted State

Two things persist across runs by default:

- **Session history**, written as append-only JSONL under `sessionDir` (default `.prime/agent/sessions`, configurable in `settings.json`). It can contain paths, command output, and other details from the session. There's no dedicated clear command today; delete the relevant session file or directory directly to reset it.
- **Stored credentials**, written to `~/.prime/agent/auth.json` (created with 0600 permissions) after `/login` or when an API key is configured this way. This lives outside `sessionDir`.

`--no-session` skips persisting or resuming a session under `sessionDir` for that run. It is not a guarantee that nothing is written anywhere: whether logs, tool-approval state, or caches outside `sessionDir` are also skipped isn't documented at the time of writing. For a run that needs to leave no trace, pair `--no-session` with an ephemeral container filesystem (as in the Docker example above) rather than relying on the flag alone.

## Pre-Run Checklist

- [ ] Disposable container/VM or dedicated non-root user, not your primary host account
- [ ] Only the target repository is writable; no `$HOME`, credentials, or SSH keys mounted
- [ ] No SSH agent forwarded, no Docker socket mounted
- [ ] Secrets are not present in the environment or mounted config
- [ ] Network access is restricted if the task doesn't need it
- [ ] Working from a clean baseline (scratch clone/branch, no uncommitted changes, no push credentials on the remote)
- [ ] Any skills, extensions, packages, or `AGENTS.md`/`CLAUDE.md` instructions have been read, not just installed
- [ ] Generated diffs/output will be reviewed before merging, pushing, or acting on them further
- [ ] For autonomous/long-running sessions specifically: a real, verifiable stopping condition is in place, not just a time or turn budget

## See Also

- [RLM Programming Model](./rlm.md) — the Trust Model section covers the kernel's permission model in more detail
- [Long-Running and Background Agents](./long-running-agents.md) — autonomous mode, heartbeats, and schedules
- [Settings](./settings.md) — `sessionDir` and resource-loading configuration
- [Architecture Overview](./architecture.md) — daemon, worker, and kernel process boundaries
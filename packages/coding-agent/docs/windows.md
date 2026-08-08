# Windows

Prime Agent runs natively on Windows. It needs Node.js and a real Bash; everything else is optional.

## Install

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

The installer mirrors `install.sh`: it checks the Node.js/npm toolchain, resolves the release for your channel, downloads the tarball plus `SHA256SUMS`, verifies the SHA-256, and runs `npm install -g`. To pin a version or skip the prompts:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Version 0.7.0 -Yes
```

If you already have Node.js 20.6+ you can also install straight from npm:

```powershell
npm install -g @earendil-works/pi-coding-agent
```

## Bash is required

The Bash tool and IPython shell cells execute through Bash, so Prime Agent needs one that can run in a Windows working directory. Checked locations, in order:

1. `shellPath` from `~/.prime/agent/settings.json`
2. Git Bash (`%ProgramFiles%\Git\bin\bash.exe`, then `%ProgramFiles(x86)%`)
3. The first usable `bash.exe` on `PATH` (Cygwin, MSYS2, …)

Each candidate must survive `bash -c "exit 0"`. [Git for Windows](https://git-scm.com/download/win) is the recommended option and is what CI uses.

`C:\Windows\System32\bash.exe` is the WSL launcher. It passes the probe when WSL is installed, but it runs a Linux distribution: the working directory arrives as `/mnt/c/...`, Windows paths the agent computed are invalid, and environment variables do not cross the boundary. Prime Agent therefore ranks it last and only falls back to it when nothing else works.

`%%bash` cells in the IPython tool are pinned to the same shell. Left to itself, IPython resolves `bash` from `PATH` and would silently run those cells inside WSL.

### Custom shell path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Optional components

| Component | Purpose | Notes |
|-----------|---------|-------|
| `uv` + Python | IPython kernel, RLM runtime | Installed on demand via `irm https://astral.sh/uv/install.ps1 \| iex`, or set `PRIME_AGENT_INSTALL_UV=1` |
| `fd`, `rg` | File and content search | Downloaded automatically into `~/.prime/agent/bin` on first use |

## Platform differences

These are the places where the Windows implementation differs from POSIX, all of them transparent in normal use:

- **Daemon transport.** Unix domain sockets have no Windows equivalent, so socket paths are mapped onto named pipes (`\\.\pipe\prime-agent-…`). The path you pass to `--daemon-socket` still identifies the daemon everywhere — in `status`, logs, and worker descriptors.
- **Daemon discovery.** Named pipes cannot be enumerated the way a socket directory can, so `prime-agent daemon status` finds daemons through worker descriptors plus a direct probe of the default pipe.
- **Process termination.** Windows has no process groups; the agent uses `taskkill /T` to reap a process together with its descendants.
- **File permissions.** Config and credential files are created with `0600`/`0700` modes, which Windows ignores. Protect `~/.prime/agent` with NTFS ACLs if the machine is shared.
- **Kernel fork server.** The IPython fork server is Linux-only (it needs `fork()`); Windows direct-spawns kernels, exactly as macOS does. This affects kernel start latency, not behaviour.
- **Symlinks.** Directory links are followed normally. Creating them needs Developer Mode or an elevated shell, so Prime Agent never creates one itself.

## Troubleshooting

**`No usable bash shell found`** — install Git for Windows, or point `shellPath` at your `bash.exe`.

**Commands fail with `'…' is not recognized as an internal or external command`** — a Windows shell ran the command instead of Bash. Check that `shellPath` resolves and that `bash -c "exit 0"` succeeds for it.

**`prime-agent` not found after install** — open a new terminal so `PATH` refreshes, or add the output of `npm prefix -g` to `PATH`.

**Antivirus blocks a download** — `fd`, `rg`, and `uv` are fetched from their upstream release pages into `~/.prime/agent/bin`. Allow that directory, or install the tools yourself and put them on `PATH`.

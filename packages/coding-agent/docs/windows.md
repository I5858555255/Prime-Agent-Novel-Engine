# Windows support

Prime Agent runs natively on Windows. It is launched from PowerShell, Command
Prompt, or Windows Terminal like any other console program — a WSL distribution
or a Git Bash session is not required, and the daemon, session workers, and the
IPython kernel all run as ordinary Windows processes.

## Requirements

| Requirement | Notes |
| --- | --- |
| Windows 10 1803+ or Windows 11 | Earlier builds lack `tar.exe`, which is used to unpack the ripgrep and fd archives. |
| Node.js 22.8 or newer | Same floor as every other platform. |
| [Git for Windows](https://git-scm.com/download/win) | Supplies the `bash.exe` that backs the agent's shell tool. |
| [uv](https://docs.astral.sh/uv/) | Installed automatically on first launch if missing; `PRIME_AGENT_INSTALL_UV=1` skips the prompt. |

Install and run:

```powershell
npm install -g prime-agent
cd C:\path\to\project
prime-agent
```

## What differs from macOS and Linux

**The Python kernel lives in `Scripts\`.** `uv` creates the kernel virtualenv at
`%USERPROFILE%\.prime\agent\kernel-venv` with the interpreter at
`Scripts\python.exe` rather than `bin/python`. Set `PRIME_AGENT_KERNEL_PYTHON`
to point at your own interpreter, or `PRIME_AGENT_KERNEL_VENV` to relocate the
managed one.

**The shell tool runs Bash, not `cmd.exe` or PowerShell.** Commands the model
writes are executed with Git for Windows' `bash.exe`, so the agent composes
POSIX-style command lines on every platform. Resolution order:

1. `shellPath` in `settings.json`, if set.
2. Git for Windows in `%ProgramFiles%`, `%ProgramFiles(x86)%`, or
   `%LOCALAPPDATA%\Programs` — this covers the machine-wide, 32-bit, and
   per-user (winget default) installers.
3. A Git install found via `git.exe` on `PATH`, which covers scoop and
   Chocolatey shims.
4. Any other `bash.exe` on `PATH` (MSYS2, Cygwin).

`%SystemRoot%\System32\bash.exe` — the WSL launcher — is deliberately ranked
last. It resolves a different filesystem (`/mnt/c/...`) than the Windows paths
the agent works with, so it is only used when nothing else is available.

To pin a specific shell, set `shellPath` in `~/.prime/agent/settings.json`:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

**`fd` and `ripgrep` are unpacked with `tar.exe`.** These optional search
helpers ship as `.zip` on Windows and are extracted into
`%USERPROFILE%\.prime\agent\bin`. Both are optional: without them the agent
falls back to slower search paths. Installing them yourself
(`winget install BurntSushi.ripgrep.MSVC`, `winget install sharkdp.fd`) makes
Prime Agent use the copies on `PATH` instead.

**asyncio subprocesses need their own event loop.** ipykernel runs on a
Windows *selector* event loop (pyzmq needs `add_reader`), and a selector loop
cannot spawn subprocesses. Prime Agent restores the proactor event loop
*policy* at kernel startup while leaving the kernel's own running loop alone,
so any loop created afterwards can spawn processes. Because the kernel's main
thread is already driving a loop, async libraries that start helper binaries —
playwright is the common one — have to run on a loop of their own:

```python
import asyncio, threading

def run_async(factory):
    box = {}
    def worker():
        loop = asyncio.new_event_loop()   # proactor loop: subprocesses work
        asyncio.set_event_loop(loop)
        try:
            box["value"] = loop.run_until_complete(factory())
        except BaseException as exc:
            box["error"] = exc
        finally:
            loop.close()
    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]
```

Use the async API rather than the sync one (`playwright.async_api`, not
`sync_playwright`): the sync API drives its own loop and conflicts with the
kernel's.

**Subprocesses are spawned with `windowsHide`.** The daemon and its session
workers are detached and therefore have no console of their own, so any console
tool they run (git, uv, python) would otherwise allocate — and flash — a console
window per invocation. Every spawn whose output is piped or discarded now
suppresses that window.

## Configuration paths

| Path | Contents |
| --- | --- |
| `%USERPROFILE%\.prime\agent` | Agent state root |
| `%USERPROFILE%\.prime\agent\kernel-venv` | Managed Python kernel virtualenv |
| `%USERPROFILE%\.prime\agent\bin` | Downloaded `rg.exe` and `fd.exe` |
| `%USERPROFILE%\.prime\agent\logs` | Daemon, worker, and client logs |
| `%USERPROFILE%\.prime\agent\sessions` | Saved session transcripts |
| `\\.\pipe\prime-agent-daemon` | Daemon socket (a named pipe, not a Unix socket) |

## Troubleshooting

**`No bash shell found`** — install Git for Windows, or point `shellPath` in
`settings.json` at a `bash.exe` you already have.

**Kernel setup fails.** First launch needs network access to install uv, Python
3.11, `ipykernel`, and the runtime packages. Check
`%USERPROFILE%\.prime\agent\logs` and re-run; to inspect the venv directly, use
`%USERPROFILE%\.prime\agent\kernel-venv\Scripts\python.exe`.

**Antivirus interference.** Real-time scanning can hold handles on freshly
extracted binaries. Provisioning `rg`/`fd` tolerates this — a failed cleanup
leaves a temp directory behind rather than failing the install — but repeated
failures usually mean `%USERPROFILE%\.prime\agent\bin` needs an exclusion.

**Stale background services** — `prime-agent doctor` inspects them and
`prime-agent shutdown --force` stops everything, including sessions in other
windows.

## Not covered

- The `install.sh` bootstrap installer is POSIX-only; use npm on Windows.
- Terminal-dependent behaviour (bracketed paste, image protocols, hyperlinks)
  varies by host. Windows Terminal is the best-supported console.
- The kernel forkserver fast path is Linux-only; Windows always cold-starts the
  kernel via `python -m ipykernel_launcher`.
- Much of the test suite uses POSIX-only fixtures (shell-scripted stubs, `chmod`
  permission bits, symlinks, `/tmp` paths) and does not run on Windows. The
  platform-sensitive suites plus an end-to-end kernel smoke test run in the
  `Windows` CI workflow.

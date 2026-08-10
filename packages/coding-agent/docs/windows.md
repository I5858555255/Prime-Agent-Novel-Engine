# Windows Setup

Prime Agent requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Python kernel bootstrap

Prime Agent spawns an IPython kernel so the model can execute Python (pandas, requests, etc.) on your machine. On Windows the kernel lives in a per-user `uv`-managed venv at `~/.prime/agent/kernel-venv/`. The kernel must be reachable at first `ipython` tool call.

### Required packages

The kernel must have **all 13** of these installed (in this order):

1. `ipykernel`
2. `prime-agent-runtime` (the bundled package — installed from `<prime-agent install dir>/dist/prime-agent-runtime/`)
3. `dill`
4. `requests`
5. `httpx`
6. `pyyaml`
7. `tomli`
8. `python-dotenv`
9. `pandas`
10. `numpy`
11. `scipy`
12. `beautifulsoup4`
13. `lxml`
14. `pydantic`
15. `tyro`

`tyro` and `dill` are the easy ones to miss. They are not obvious from the failure message — the bootstrap only reports the first missing group per run.

### One-shot provisioning (recommended)

The bootstrap will run on first use if not skipped. **It is destructive**: each retry wipes the kernel venv and re-creates it. If you have pre-installed packages, the retry loses them. To avoid this, **provision the venv yourself and point Prime Agent at it via `PRIME_AGENT_KERNEL_PYTHON`**.

#### PowerShell (recommended for Windows)

```powershell
$uv  = "$env:USERPROFILE\.local\bin\uv.exe"
$py  = "$env:USERPROFILE\.prime\agent\kernel-venv\Scripts\python.exe"
$rt  = "$env:APPDATA\npm\node_modules\prime-agent\dist\prime-agent-runtime"

# create the venv and install everything Prime Agent needs in one shot
& $uv venv --python 3.11 --seed "$env:USERPROFILE\.prime\agent\kernel-venv" --clear
& $uv pip install --python $py ipykernel $rt `
    dill requests httpx pyyaml tomli python-dotenv `
    pandas numpy scipy beautifulsoup4 lxml pydantic tyro

# tell Prime Agent to use this Python instead of running its own bootstrap
[System.Environment]::SetEnvironmentVariable("PRIME_AGENT_KERNEL_PYTHON", $py, "User")
```

After this, the first `ipython` tool call skips the bootstrap entirely and the kernel boots in <1 second.

#### Git Bash

```bash
uv=~/.local/bin/uv.exe
py="$HOME/.prime/agent/kernel-venv/Scripts/python.exe"
rt="$(npm root -g)/prime-agent/dist/prime-agent-runtime"

"$uv" venv --python 3.11 --seed "$HOME/.prime/agent/kernel-venv" --clear
"$uv" pip install --python "$py" \
    ipykernel "$rt" \
    dill requests httpx pyyaml tomli python-dotenv \
    pandas numpy scipy beautifulsoup4 lxml pydantic tyro
```

### PowerShell wrapper must copy user-level env vars

`setx` writes a user-level env var, but **PowerShell does NOT auto-inherit user-level env vars into the process env** (`cmd` does). If your `prime-agent.ps1` wrapper runs under PowerShell, the spawned `prime-agent` won't see `PRIME_AGENT_KERNEL_PYTHON` (or `MINIMAX_API_KEY`, etc.) unless the wrapper explicitly copies them in.

Minimal wrapper snippet that works:

```powershell
# Pull user-level env vars into the process env BEFORE spawning prime-agent.
foreach ($name in @(
    'PRIME_AGENT_KERNEL_PYTHON',
    'MINIMAX_API_KEY',
    'PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL',
    'PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL'
)) {
    $value = [System.Environment]::GetEnvironmentVariable($name, 'User')
    if ($value -and [string]::IsNullOrEmpty($env:$name)) {
        [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

& prime-agent --cwd $PSScriptRoot @args
```

### Stale `session-leases/*.lock` blocks resume

Prime Agent's `proper-lockfile` uses **directories** as locks on Windows. If a previous `prime-agent` was killed (e.g. by `npm update` or `Stop-Process`), the `.lock` directory is left behind. The next resume then fails with:

```
EPERM: rename ...lock.candidate-XXX → ...lock
```

because Windows cannot rename a file to a directory name.

Your wrapper should clear stale locks whose owner PID is no longer running before spawning `prime-agent`:

```powershell
Get-ChildItem -Path "$env:USERPROFILE\.prime\agent\session-leases" -Filter "*.lock" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = Get-Content "$($_.FullName)\owner.json" -Raw -ErrorAction SilentlyContinue |
        ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $owner -or -not (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
```

### Failure mode symptoms (for diagnosis)

If `prime-agent` reports the kernel is broken, check in order:

1. **`uv pip install ... bin/python ... exit code 2`** → the bootstrap is hitting the POSIX-only path. Prime Agent v0.7.0 / v0.7.1 has this bug. Workaround: provision manually and set `PRIME_AGENT_KERNEL_PYTHON` (see above). Fixed in PR #825.
2. **`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ...`** → the override Python is missing one of the 13 packages. Re-run the one-shot provisioning with the full list.
3. **`EPERM: rename ... lock`** → a stale session-leases lock. Run the lock-cleanup snippet above.
4. **Kernel "ready" but tools don't see Python** → `~/.prime/agent/kernel-venv/.bootstrap-version` is out-of-sync with the runtime source. Delete the file and let the next `ipython` call rebuild the kernel.
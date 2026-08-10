# Windows Setup

Prime Agent runs natively on Windows from a bash shell. It was primarily developed and tested on macOS and Linux, so expect rough edges; the modern [Windows Terminal](https://github.com/microsoft/terminal) is recommended for the TUI (24-bit color and VT input are only exercised there).

Prime Agent requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient. Use the **Git Bash** profile in Windows Terminal.

## Prerequisites

- [Git for Windows](https://git-scm.com/download/win) (provides Git Bash)
- Node.js 22.8.0 or newer and npm
- [uv](https://docs.astral.sh/uv/) (only if Prime Agent bootstraps the IPython kernel itself; it can also download uv automatically)

## Installation

From a Git Bash prompt, run the official installer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Then start Prime Agent in the project directory you want it to work on:

```bash
cd /path/to/project
prime-agent
```

### npm 12 and the installer

npm 12 (2026) changed two behaviors that affect Prime Agent's release tarball:

- **Remote dependencies are refused by default** (`EALLOWREMOTE`): the `prime-agent` tarball depends on sibling packages served from the release CDN. Enable them first:

  ```bash
  npm config set allow-remote all
  ```

  This setting also lives in the user `~/.npmrc`, so it applies to `prime-agent update` self-updates as well.

- **Global installs may fail with `EPERM`** if npm's global prefix resolves to a system directory such as `C:\Program Files\npm`, which is not writable without an elevated shell. npm ignores `prefix` set in `.npmrc`; use the environment variable instead:

  ```bash
  export NPM_CONFIG_PREFIX="$APPDATA/npm"
  curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
  ```

  Make sure `%APPDATA%\npm` is on your PATH (or add it via System Settings → Environment Variables), then open a new terminal.

## Running from a Source Checkout

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
./prime-agent.sh
```

The source runner preserves the directory from which it is invoked, so you can call `/path/to/prime-agent/prime-agent.sh` from another project. `./prime-agent.sh --dist` runs the bundled build instead of tsx.

### npm 12 blocks some install scripts

npm 12 gates lifecycle scripts behind its `allow-scripts` policy, so `npm ci` may warn that install scripts for packages such as `esbuild`, `zeromq`, `koffi`, or `canvas` were blocked. This is harmless for Prime Agent:

- `esbuild`, `zeromq`, and `koffi` ship prebuilt binaries and work without their install scripts.
- `canvas` is a transitive dependency that the source does not import.

If you need a native module that was blocked, allow and rebuild it explicitly:

```bash
npm install-scripts approve <pkg>
npm rebuild <pkg>
```

## IPython Kernel Runtime

The agent's only built-in tool is `ipython`, backed by a managed Python kernel venv at `~/.prime/agent/kernel-venv/`. On first use Prime Agent bootstraps it with uv (Python 3.11 + `ipykernel` + `prime-agent-runtime` + default packages), resolving the venv interpreter at `kernel-venv/Scripts/python.exe` on Windows and `kernel-venv/bin/python` elsewhere.

Older releases resolved the interpreter only at the POSIX path, so automatic bootstrap failed on Windows. On those versions, or to reuse an existing Python instead of the managed venv, set `PRIME_AGENT_KERNEL_PYTHON` to a Python that already has `ipykernel`, `prime-agent-runtime`, and the default packages; Prime Agent validates and uses it without bootstrapping.

Prepare such a Python once (or repair the managed venv):

```bash
# Create the venv and install the runtime into it
uv venv ~/.prime/agent/kernel-venv --python 3.11 --seed

# The bundled runtime lives next to the install; adapt the path for source checkouts
uv pip install --python "$HOME/.prime/agent/kernel-venv/Scripts/python.exe" \
  ipykernel \
  "$APPDATA/npm/node_modules/prime-agent/dist/prime-agent-runtime" \
  dill requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro

# Make every Prime Agent process use it
setx PRIME_AGENT_KERNEL_PYTHON "%USERPROFILE%\.prime\agent\kernel-venv\Scripts\python.exe"
```

Restart your terminals after `setx`. Existing Python environments with `ipykernel` and `prime-agent-runtime` installed also work, as documented under `PRIME_AGENT_KERNEL_PYTHON` in [skills.md](skills.md).

## Known Limitations

- **Use Windows Terminal**: the TUI targets modern terminals; legacy `conhost` windows will render poorly.
- **Flashing console windows**: some child processes spawn a visible console window that briefly steals focus while they run.
- **Resume failing with `EPERM`**: a crashed session worker can leave stale locks under `~/.prime/agent/session-leases/`; delete that directory and retry.
- **`fsync` noise in logs**: Windows cannot fsync directories, which logs `EPERM` errors; they are harmless.
- **No background suspend**: `app.suspend` (Ctrl+Z) is unavailable on native Windows because Windows terminals lack job control. It works under WSL.
- **Image paste**: use `Alt+V` (not Ctrl+V) to paste images into the TUI.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

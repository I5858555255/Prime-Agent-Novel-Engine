# Windows Setup

Prime Agent installs and runs natively on Windows with PowerShell. WSL and Git Bash are not required for the install itself, but a bash shell is required at runtime (see [Bash requirement](#bash-requirement)).

## Install

Run this in Windows PowerShell 5.1 or PowerShell 7+:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

To try the latest beta built from `main`:

```powershell
irm https://app.primeintellect.ai/prime-agent/install-beta.ps1 | iex
```

The installer resolves the current release, downloads the release tarball and `SHA256SUMS`, verifies the SHA-256 checksum, and installs the `prime-agent` command with `npm install -g`. It asks before installing and before preparing the IPython runtime; both default to yes, and both are assumed when no terminal is attached.

Then start Prime Agent in the directory you want it to work on:

```powershell
cd C:\path\to\project
prime-agent
```

## Requirements

- Windows PowerShell 5.1 or PowerShell 7+
- Node.js 20.6.0 or newer and npm on PATH
- A bash shell for the agent's shell commands

The installer does not install Node.js for you. If it is missing:

```powershell
winget install OpenJS.NodeJS.LTS
```

Or download an installer from [nodejs.org](https://nodejs.org). Open a new terminal afterwards so `node` and `npm` are on PATH.

## Installer Options

Environment variables, set before piping the installer to `iex`:

| Variable | Purpose |
| --- | --- |
| `PRIME_AGENT_RELEASE_CHANNEL` | `stable` or `beta` |
| `PRIME_AGENT_VERSION` | Install an explicit version instead of the channel's current release |
| `PRIME_AGENT_DOWNLOAD_BASE_URL` | Alternate release host |
| `PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL` | `1` prepares the IPython runtime during install, `0` skips it |
| `PRIME_AGENT_PACKAGE`, `PRIME_AGENT_CMD` | Package and command name overrides |

```powershell
$env:PRIME_AGENT_RELEASE_CHANNEL = 'beta'
$env:PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL = '1'
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

A downloaded copy of the installer also accepts a channel or version as its first argument:

```powershell
Invoke-WebRequest https://app.primeintellect.ai/prime-agent/install.ps1 -OutFile install.ps1
./install.ps1 beta
./install.ps1 0.7.1
```

## PATH

`npm install -g` puts `prime-agent.cmd` in npm's global prefix. If the command is not found after installing, print the prefix and add it to PATH:

```powershell
npm config get prefix
```

For the current session only:

```powershell
$env:Path = "$(npm config get prefix);" + $env:Path
```

Make it permanent through System Settings, `Environment Variables`, or `setx PATH`. A newly opened terminal also picks up PATH changes made by the Node.js installer.

## Bash requirement

The agent runs shell commands, `%%bash` cells, and some tools through bash. Checked locations (in order):

1. Custom path from `shellPath` in `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`, then the 32-bit Program Files location)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

### Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## IPython Runtime

The first IPython use (or the install-time prompt) bootstraps the kernel runtime:

- `uv` is installed with the official PowerShell installer to `%USERPROFILE%\.local\bin\uv.exe` when it is not already available
- `uv` installs Python 3.11, `ipykernel`, `prime-agent-runtime`, and the default Python packages
- The kernel virtual environment lives in `%USERPROFILE%\.prime\agent\kernel-venv`

The uv installer only adds `%USERPROFILE%\.local\bin` to the persisted user PATH, so `uv` is not on PATH in the current terminal; Prime Agent looks for the binary in that directory directly. Set `PRIME_AGENT_KERNEL_PYTHON` to an existing Python with `ipykernel` and a current `prime-agent-runtime` to skip the bootstrap entirely.

## Known Limitations

- A bash shell must be installed for shell commands to work; Prime Agent does not fall back to `cmd.exe` or PowerShell.
- Image paste uses Alt+V instead of Ctrl+V.
- Windows Terminal is recommended; older console hosts render the TUI poorly.
- Running the Linux installer inside WSL is still supported and is the better option if a project needs a Linux toolchain.

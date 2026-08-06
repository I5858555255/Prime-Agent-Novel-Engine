# Windows Setup

Install Prime Agent from PowerShell or Windows Terminal:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

The installer requires Node.js 22.8 or newer. It downloads the selected release, verifies its SHA-256 checksum, installs the `prime-agent` command globally with npm, and prepares the IPython runtime. To install the current beta instead:

```powershell
irm https://app.primeintellect.ai/prime-agent/install-beta.ps1 | iex
```

Prime Agent launches, manages background agents, and runs its Python kernel natively on Windows. Its model-facing shell remains Bash for command compatibility. Checked Bash locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

After installation, open the repository or directory Prime Agent should work in and run:

```powershell
prime-agent
```

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

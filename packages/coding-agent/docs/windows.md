# Windows Setup

Prime Agent requires a Bash shell that can actually execute on Windows. Git Bash is the recommended option. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. A usable `bash.exe` on PATH (Cygwin, MSYS2, or a configured WSL installation)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient. The Windows WSL launcher is ignored when `bash.exe -c "exit 0"` cannot run successfully.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

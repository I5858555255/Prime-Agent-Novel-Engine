# Kernel runtime lock

`uv.lock` is the reviewed dependency set for Prime Agent's managed Python 3.11 kernel. It covers the bundled base runtime only; Python skill packages and their dependencies are installed separately so user and project skills do not become part of the release lock.

Refresh and validate the lock from the repository root:

```bash
npm run refresh-python-lock
```

The update command excludes artifacts uploaded within the last seven days, upgrades the lock, and verifies resolution for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`, and Termux on `android-arm64`. Desktop release targets require wheels; Termux may build distributions from their locked source archives. Review both direct and transitive version changes before committing the generated `uv.lock`.

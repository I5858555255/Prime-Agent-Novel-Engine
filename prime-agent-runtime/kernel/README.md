# Kernel runtime lock

This directory is the reviewed base environment for Prime Agent's Python kernel:

- `pyproject.toml` declares the bundled base runtime dependencies.
- `uv.lock` records exact artifacts and hashes for supported Python versions and targets.
- `constraints.txt` is generated from the lock and constrains separately installed Python skills.
- `toolchain.json` pins the managed CPython patch, uv release, seven-day release cutoff, and reviewed Termux Python range.
- `vendor_termux_packages.py` copies exact, patched Termux native distributions into a staged kernel environment.

Desktop bootstraps use the exact managed CPython and uv versions in `toolchain.json`. Linux selects GNU or musl wheels from the detected libc. Termux uses its system Python because uv does not provide managed CPython for Android. Its interpreter and official patched native package revisions are validated, copied into the isolated venv, and recorded in the bootstrap identity. Skill packages remain outside the base lock, but their resolution is constrained and the locked base is restored after every skill change.

Validate committed artifacts without modifying them:

```bash
npm run check:python-lock
```

Refresh reviewed dependencies from the repository root with the uv version currently recorded in `toolchain.json`:

```bash
npm run refresh-python-lock
```

The refresh command advances the recorded cutoff to seven days before the run, updates the lock and constraints, and validates macOS ARM64/x64, glibc Linux ARM64/x64, musl Linux ARM64/x64, and Windows x64. CI also performs native Windows installation and real Termux/Bionic online and cached-offline installation. Termux native package revisions are updated manually after the same seven-day cooldown and must keep their Python distribution versions aligned with the lock. Review changes to `toolchain.json`, `uv.lock`, and `constraints.txt` together.

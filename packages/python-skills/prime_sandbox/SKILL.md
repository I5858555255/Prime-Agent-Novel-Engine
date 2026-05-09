# prime_sandbox

Use `prime_sandbox` to create, inspect, run commands in, transfer files to,
expose ports from, and delete Prime code sandboxes.

## Python

```python
import prime_sandbox

sandboxes = await prime_sandbox.run(action="list")
created = await prime_sandbox.run(
    action="create",
    docker_image="python:3.12",
    name="debug",
    yes=True,
)
output = await prime_sandbox.run(
    action="run",
    sandbox_id="sb_123",
    command=["bash", "-lc", "python --version"],
)
```

File and port operations:

```python
await prime_sandbox.run(action="upload", sandbox_id="sb_123", local_file="main.py", remote_path="/tmp/main.py")
await prime_sandbox.run(action="download", sandbox_id="sb_123", remote_path="/tmp/out.txt", local_file="out.txt")
await prime_sandbox.run(action="expose", sandbox_id="sb_123", port=8000, name="api")
```

The return value includes `command`, `returncode`, `stdout`, `stderr`, and
`data` when JSON output is parsed.

## CLI

```bash
prime_sandbox --action list
prime_sandbox --action run --sandbox-id sb_123 --command python --command --version
```

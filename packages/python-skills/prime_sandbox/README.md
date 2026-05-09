# prime_sandbox

RLM skill for Prime sandbox lifecycle operations.

```python
import prime_sandbox

sandboxes = await prime_sandbox.run(action="list")
created = await prime_sandbox.run(action="create", docker_image="python:3.12", yes=True)
output = await prime_sandbox.run(action="run", sandbox_id="sb_123", command=["python", "--version"])
```

The package wraps `prime --plain sandbox ...` and returns command metadata plus
parsed JSON output when the CLI emits JSON.

# prime_hub

Use `prime_hub` to search Prime Intellect Environments Hub before pulling,
installing, evaluating, or training against an environment.

## Python

```python
import prime_hub

results = await prime_hub.run(
    query="browser",
    max_results=10,
    tags=["openenv"],
)
```

The return value includes:

- `command`: the exact `prime` argv used
- `returncode`, `stdout`, `stderr`
- `data`: parsed JSON when `prime` emits valid JSON

## CLI

```bash
prime_hub --query browser --max-results 10 --tags openenv
```

Use `data["environments"]` to inspect environment names, descriptions,
versions, tags, stars, and action status.

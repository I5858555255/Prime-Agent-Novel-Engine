# prime_envs

Use `prime_envs` to list, inspect, pull, push, or install verifiers
environments through the Prime CLI.

## Python

```python
import prime_envs

envs = await prime_envs.run(action="list", search="math", max_results=10)
info = await prime_envs.run(action="info", env_id="primeintellect/wordle")
pulled = await prime_envs.run(action="pull", env_id="primeintellect/wordle", target="./wordle")
installed = await prime_envs.run(action="install", env_ids=["primeintellect/wordle"])
```

For `push`, pass `path`, and optionally `name`, `owner`, `team`,
`visibility`, and version bump flags.

The return value includes `command`, `returncode`, `stdout`, `stderr`, and
`data` when JSON output is parsed.

## CLI

```bash
prime_envs --action list --search math --max-results 10
prime_envs --action install --env-ids primeintellect/wordle
```

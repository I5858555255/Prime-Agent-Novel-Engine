# prime_rl_train

Use `prime_rl_train` to launch hosted RL training runs and monitor training
state, logs, metrics, samples, checkpoints, components, usage, and available
models/configs.

## Python

```python
import prime_rl_train

run = await prime_rl_train.run(action="run", config_path="rl.toml", yes=True)
metrics = await prime_rl_train.run(action="metrics", run_id="rft_123", limit=100)
logs = await prime_rl_train.run(action="logs", run_id="rft_123", tail=200)
```

Useful monitoring calls:

```python
await prime_rl_train.run(action="progress", run_id="rft_123")
await prime_rl_train.run(action="rollouts", run_id="rft_123", step=50, max_results=20)
await prime_rl_train.run(action="checkpoints", run_id="rft_123", status="READY")
await prime_rl_train.run(action="usage", run_id="rft_123")
```

The return value includes `command`, `returncode`, `stdout`, `stderr`, and
`data` when JSON output is parsed.

## CLI

```bash
prime_rl_train --action models
prime_rl_train --action run --config-path rl.toml --yes
prime_rl_train --action logs --run-id rft_123 --tail 200
```

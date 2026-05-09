# prime_rl_train

RLM skill for launching and monitoring Prime hosted RL training.

```python
import prime_rl_train

launched = await prime_rl_train.run(action="run", config_path="rl.toml", yes=True)
progress = await prime_rl_train.run(action="progress", run_id="rft_123")
```

The package wraps `prime --plain train ...` and returns command metadata plus
parsed JSON output when the CLI emits JSON.

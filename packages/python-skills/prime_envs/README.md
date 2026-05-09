# prime_envs

RLM skill for Prime Intellect environment lifecycle operations.

```python
import prime_envs

envs = await prime_envs.run(action="list", search="wordle", output_json=True)
pulled = await prime_envs.run(action="pull", env_id="primeintellect/wordle", target="./envs/wordle")
```

The package wraps `prime --plain env ...` and returns command metadata plus
parsed JSON output when requested and available.

# prime_eval

Use `prime_eval` to launch hosted evals, inspect eval status/results, fetch
samples/logs, stop running evals, or push local eval output to Prime Evals.

## Python

```python
import prime_eval

result = await prime_eval.run(
    action="run",
    environment="primeintellect/wordle",
    model="openai/gpt-5.5",
    num_examples=10,
    hosted=True,
    allow_sandbox_access=True,
    allow_tunnel_access=True,
)
```

List and inspect results:

```python
evals = await prime_eval.run(action="list", env_name="primeintellect/wordle")
details = await prime_eval.run(action="get", eval_id="eval_123")
samples = await prime_eval.run(action="samples", eval_id="eval_123", max_results=20)
```

The return value includes `command`, `returncode`, `stdout`, `stderr`, and
`data` when JSON output is parsed.

## CLI

```bash
prime_eval --action list --env-name primeintellect/wordle
prime_eval --action get --eval-id eval_123
```

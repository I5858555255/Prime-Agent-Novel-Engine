# prime_eval

RLM skill for launching and inspecting Prime Intellect evaluations.

```python
import prime_eval

run = await prime_eval.run(
    action="run",
    environment="primeintellect/wordle",
    model="openai/gpt-5.5",
    num_examples=10,
)
```

The package wraps `prime --plain eval ...` and returns command metadata plus
parsed JSON output when the CLI emits JSON.

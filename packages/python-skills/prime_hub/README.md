# prime_hub

RLM skill for searching Prime Intellect Environments Hub entries.

```python
import prime_hub

results = await prime_hub.run(query="wordle", max_results=10)
```

The package wraps `prime --plain env list --search ... --output json` and
returns command metadata plus parsed JSON output when the CLI emits JSON.

# prime_gpu

RLM skill for Prime GPU availability and pod lifecycle operations.

```python
import prime_gpu

available = await prime_gpu.run(action="availability", gpu_type="H100_80GB", gpu_count=8)
pod = await prime_gpu.run(action="create", gpu_type="H100_80GB", gpu_count=1, name="debug", yes=True)
```

The package wraps `prime --plain availability ...` and `prime --plain pods ...`.

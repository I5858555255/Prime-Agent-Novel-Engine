# prime_gpu

Use `prime_gpu` to inspect GPU availability/pricing and manage Prime compute
pods.

## Python

```python
import prime_gpu

types = await prime_gpu.run(action="gpu_types")
available = await prime_gpu.run(action="availability", gpu_type="H100_80GB", gpu_count=8)
pods = await prime_gpu.run(action="list")
status = await prime_gpu.run(action="status", pod_id="pod_123")
```

Create and terminate pods explicitly:

```python
created = await prime_gpu.run(
    action="create",
    gpu_type="H100_80GB",
    gpu_count=1,
    name="debug-pod",
    image="pytorch/pytorch:latest",
    yes=True,
)
terminated = await prime_gpu.run(action="terminate", pod_id="pod_123", yes=True)
```

The return value includes `command`, `returncode`, `stdout`, `stderr`, and
`data` when JSON output is parsed.

## CLI

```bash
prime_gpu --action availability --gpu-type H100_80GB --gpu-count 8
prime_gpu --action list
```

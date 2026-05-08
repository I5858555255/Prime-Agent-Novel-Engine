# Kernel boundary spike

Throwaway: validates TS↔IPython kernel round-trip via Jupyter's ZMQ messaging protocol, with state persisting across requests.

This is the M1 validation gate from `~/pi/prime-agent-design/PLAN.md`. Promote to `packages/kernel/` once the architecture is settled.

## Run

```bash
./setup.sh    # creates .venv with ipykernel; installs npm deps
npm run spike
```

Pass criteria: the script sets `x = 42` in one request and prints `x * 2 = 84` in a follow-up request. State persistence is the property being validated.

## What's implemented vs. left for later

Implemented:
- Connection file generation, kernel spawn, ZMQ DEALER (shell) + SUB (iopub).
- HMAC-SHA256 message signing.
- `execute_request` round-trip with `stream` output capture and `status: idle` completion detection.

Deliberately skipped (this is a spike, not a kernel manager):
- Signature *verification* on incoming messages (we trust the kernel we just spawned).
- The `control`, `stdin`, `hb` channels.
- `display_data`, `execute_result`, image / mime handling.
- Interrupts, restarts.
- Slow-joiner mitigation beyond a 500ms warm-up.
- Multi-request concurrency, error recovery.
- Comm channels (we'll need these for `await rlm('...')` recursion in M4).

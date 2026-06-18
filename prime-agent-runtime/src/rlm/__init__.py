"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import asyncio
import os
import re
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .async_runtime import (
    BackgroundWorker,
    FnProcessor,
    Handle,
    Registry,
    ToolState,
    attach_background,
    close_all_registries,
)
from .harness import HarnessEntry, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on ipykernel version
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class RLMResult:
    answer: str
    session_dir: Path | None = None
    usage: TokenUsage = field(default_factory=TokenUsage)
    turns: int = 0


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc


def _ensure_recursion_allowed() -> None:
    depth = _env_int("RLM_DEPTH", 0)
    max_depth = _env_int("RLM_MAX_DEPTH", 1)
    if depth >= max_depth:
        raise RuntimeError(
            f"RLM recursion depth limit reached "
            f"(RLM_DEPTH={depth}, RLM_MAX_DEPTH={max_depth})"
        )


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _result_from_payload(payload: dict[str, Any]) -> RLMResult:
    usage_payload = payload.get("usage")
    usage = TokenUsage()
    if isinstance(usage_payload, dict):
        usage = TokenUsage(
            prompt_tokens=int(usage_payload.get("prompt_tokens", 0)),
            completion_tokens=int(usage_payload.get("completion_tokens", 0)),
        )

    session_dir_payload = payload.get("session_dir")
    session_dir = Path(session_dir_payload) if isinstance(session_dir_payload, str) else None
    return RLMResult(
        answer=str(payload.get("answer", "")),
        usage=usage,
        turns=int(payload.get("turns", 0)),
        session_dir=session_dir,
    )


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a typed request to the Prime Agent host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Raises RuntimeError when the host reports an error or when no
    handler for the type is registered in this session.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":
            def _resolve_result() -> None:
                if not future.done():
                    future.set_result({k: v for k, v in reply.items() if k != "status"})
                    comm.close()

            loop.call_soon_threadsafe(_resolve_result)
            return
        if status == "error":
            message = reply.get("error") or f"host request {request_type} failed"
            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(RuntimeError(str(message)))
                    comm.close()

            loop.call_soon_threadsafe(_resolve_error)
            return

        unexpected = f"host request {request_type} returned unexpected status: {status!r}"
        def _resolve_unexpected() -> None:
            if not future.done():
                future.set_exception(RuntimeError(unexpected))
                comm.close()

        loop.call_soon_threadsafe(_resolve_unexpected)

    comm.on_msg(_on_msg)
    # request_type goes last so a payload "type" key cannot reroute the request.
    comm.open(data={**(payload or {}), "type": request_type})
    return await future


async def run(prompt: str, **kwargs: Any) -> RLMResult:
    """Run a recursive Prime Agent child through the TypeScript host."""
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    _ensure_recursion_allowed()
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _result_from_payload(payload)


def sanitize_name(name: str) -> str:
    """Make ``name`` filesystem-safe for a session dir; non-empty and bounded."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", name).strip("-")
    return (safe or "agent")[:64]


# ---------------------------------------------------------------------------
# Background / persistent sub-agents via host bridge
# ---------------------------------------------------------------------------

# Per-kernel registry for named sub-agents. Imported fresh per kernel, so
# naturally per-kernel (hierarchical).
REGISTRY = Registry()


class _HostRlmProcessor:
    """Stateful processor: each item is a prompt sent to the TS host.

    The host manages the actual AgentSession lifecycle. This processor
    sends ``rlm.send.advance`` requests for each queued prompt and
    returns the ``RLMResult``.
    """

    def __init__(self, agent_name: str, session_dir: str | None = None):
        self._agent_name = agent_name
        self._session_dir = session_dir

    async def process(self, prompt: str) -> RLMResult:
        payload = await host_request("rlm.send.advance", {
            "name": self._agent_name,
            "prompt": prompt,
        })
        return _result_from_payload(payload)

    async def teardown(self) -> None:
        try:
            await host_request("rlm.send.close", {
                "name": self._agent_name,
            })
        except Exception:
            pass


async def send(
    prompt: str,
    name: str | None = None,
    max_tokens: int | None = None,
    **kwargs: Any,
) -> Handle:
    """Start or continue a named, persistent background sub-agent.

    Returns a handle immediately; keep it in a variable and ``handle.poll()`` it
    from a later cell. Re-sending the same ``name`` appends a turn to the same
    agent (multi-turn). ``name=None`` draws a random auto-name.
    ``max_tokens`` caps the sub-agent's completion-token budget.
    """
    _ensure_recursion_allowed()

    if name is not None:
        name = sanitize_name(name)

    # Non-positive request means "no explicit budget"
    if max_tokens is not None and max_tokens <= 0:
        max_tokens = None

    def worker_factory(agent_name: str) -> BackgroundWorker:
        # Ask the host to create the persistent subagent session
        loop = asyncio.get_event_loop()
        creation_result = loop.run_until_complete(
            host_request("rlm.send.create", {
                "name": agent_name,
                "max_tokens": max_tokens,
                **kwargs,
            })
        )
        session_dir = creation_result.get("session_dir")
        processor = _HostRlmProcessor(agent_name, session_dir)
        return BackgroundWorker(agent_name, processor, session_dir=session_dir)

    return REGISTRY.send(prompt, name=name, worker_factory=worker_factory)


async def drain_agents() -> None:
    """Close every background agent in this kernel (all registries).

    Invoked by the engine's teardown cascade as a cell executed in the kernel.
    """
    await close_all_registries()


try:
    _harness_state = get_harness_state()
except Exception:  # pragma: no cover - harness state must never break `import rlm`
    _harness_state = HarnessState(in_memory=True)


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)

    @staticmethod
    async def send(
        prompt: str,
        name: str | None = None,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> Handle:
        """Start or continue a named, persistent background sub-agent.

        Returns a handle immediately; keep it in a variable and ``handle.poll()`` it
        from a later cell. Re-sending the same ``name`` appends a turn to the same
        agent (multi-turn). ``name=None`` draws a random auto-name.
        """
        return await send(prompt, name=name, max_tokens=max_tokens, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMResult:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "BackgroundWorker",
    "FnProcessor",
    "Handle",
    "HarnessEntry",
    "HarnessState",
    "RLMResult",
    "REGISTRY",
    "Registry",
    "RefinementEvent",
    "TokenUsage",
    "ToolState",
    "attach_background",
    "close_all_registries",
    "drain_agents",
    "get_harness_state",
    "harness",
    "host_request",
    "rlm",
    "run",
    "sanitize_name",
    "send",
]

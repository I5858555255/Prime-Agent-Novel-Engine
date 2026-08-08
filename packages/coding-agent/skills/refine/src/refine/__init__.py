"""Prime Agent refine skill: continual harness refinement from the kernel.

Refinement runs host-side (the same implementation as /refine); these
functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent IPython kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def status() -> dict[str, Any]:
    """Read current refine state.

    Returns a dict with `pending` (whether a requested refine is already
    queued for this turn) and `in_flight` (whether a refine is currently
    planning or applying).
    """
    return await host_request("refine.status")


async def run(
    instructions: str | None = None,
    global_: bool = False,
    plan_id: str | None = None,
) -> dict[str, Any]:
    """Schedule continual harness refinement.

    Refinement never runs mid-cell: it runs when the current turn ends and
    the harness applies changes and rebuilds the system prompt, then resumes
    you automatically. Returns `{"scheduled": True}`, or
    `{"scheduled": False, "reason": ...}` when refinement cannot start.
    Optional `instructions` focus the refinement on a specific observation.
    Set `global_=True` to target the global (cross-session) harness store;
    omit for local (session-scoped) refinement. Pass `plan_id` from a prior
    `refine.preview()` call to apply exactly that previewed plan instead of
    re-planning; `instructions` and `global_` are ignored in that case
    because the previewed plan already carries them.
    """
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(
            f"instructions must be str or None, got {type(instructions).__name__}"
        )
    if not isinstance(global_, bool):
        raise TypeError(f"global_ must be bool, got {type(global_).__name__}")
    if plan_id is not None and not isinstance(plan_id, str):
        raise TypeError(f"plan_id must be str or None, got {type(plan_id).__name__}")
    payload: dict[str, Any] = {}
    if instructions is not None:
        payload["instructions"] = instructions
    if global_:
        payload["global"] = True
    if plan_id is not None:
        payload["plan_id"] = plan_id
    return await host_request("refine.run", payload)


async def preview(
    instructions: str | None = None,
    global_: bool = False,
) -> dict[str, Any]:
    """Plan a refinement and return the proposed edits without applying them.

    Runs the planning pass immediately and returns the proposal:
    `plan_id`, `summary`, `rationale`, `expected_outcome`, `scope`, and
    `edits` (each with `action`, `kind`, `id`, `title`, `content`,
    `reason`). Nothing is scheduled or written. To apply exactly this
    plan, pass the returned `plan_id` to `refine.run(plan_id=...)`;
    calling `refine.run()` without it re-plans from scratch. An empty
    `edits` list with a rationale means no useful edit was identified.
    """
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(
            f"instructions must be str or None, got {type(instructions).__name__}"
        )
    if not isinstance(global_, bool):
        raise TypeError(f"global_ must be bool, got {type(global_).__name__}")
    payload: dict[str, Any] = {}
    if instructions is not None:
        payload["instructions"] = instructions
    if global_:
        payload["global"] = True
    return await host_request("refine.preview", payload)

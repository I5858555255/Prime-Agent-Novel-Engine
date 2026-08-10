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


SCOPES = ("local", "project", "global")


async def run(
    instructions: str | None = None,
    scope: str | None = None,
) -> dict[str, Any]:
    """Schedule continual harness refinement.

    Refinement never runs mid-cell: it runs when the current turn ends and
    the harness applies changes and rebuilds the system prompt, then resumes
    you automatically. Returns `{"scheduled": True}`, or
    `{"scheduled": False, "reason": ...}` when refinement cannot start.
    Optional `instructions` focus the refinement on a specific observation.
    `scope` selects the target store: "local" (this session, the default),
    "project" (this repository, across sessions), or "global" (every session
    and project).
    """
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(
            f"instructions must be str or None, got {type(instructions).__name__}"
        )
    if scope is not None and scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}, got {scope!r}")
    payload: dict[str, Any] = {}
    if instructions is not None:
        payload["instructions"] = instructions
    if scope is not None:
        payload["scope"] = scope
    return await host_request("refine.run", payload)

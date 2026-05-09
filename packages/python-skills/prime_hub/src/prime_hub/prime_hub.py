from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


def _run_prime(args: list[str], timeout_seconds: float) -> dict[str, object]:
    prime = shutil.which("prime")
    if prime is None:
        raise RuntimeError("prime CLI not found on PATH")

    command = [prime, "--plain", *args]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    stdout = completed.stdout.strip()
    data: object | None = None
    if stdout:
        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            data = None

    return {
        "command": ["prime", "--plain", *args],
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "data": data,
    }


async def run(
    query: str = "",
    max_results: int = 20,
    page: int = 1,
    owner: str | None = None,
    visibility: Literal["PUBLIC", "PRIVATE"] | None = None,
    tags: list[str] | None = None,
    action_status: Literal["SUCCESS", "FAILED", "RUNNING", "PENDING"] | None = None,
    sort: Literal["name", "created_at", "updated_at", "stars"] = "stars",
    order: Literal["asc", "desc"] = "desc",
    include_actions: bool = True,
    starred: bool = False,
    mine: bool = False,
    timeout_seconds: float = 60.0,
) -> dict[str, object]:
    """Search Prime Intellect Environments Hub entries.

    Args:
        query: Search string matched against environment names and descriptions.
        max_results: Items per page to request.
        page: Page number to request.
        owner: Optional owner filter.
        visibility: Optional visibility filter.
        tags: Optional tag filters. Repeatable.
        action_status: Optional environment action status filter.
        sort: Sort key.
        order: Sort order.
        include_actions: Include action status columns in the CLI request.
        starred: Return only starred environments.
        mine: Return only environments owned by the active account or team.
        timeout_seconds: CLI timeout in seconds.

    Returns:
        A dictionary with command metadata and parsed hub search data.
    """
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if page < 1:
        raise ValueError("page must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    args = [
        "env",
        "list",
        "--output",
        "json",
        "--num",
        str(max_results),
        "--page",
        str(page),
        "--sort",
        sort,
        "--order",
        order,
    ]
    cleaned_query = query.strip()
    if cleaned_query:
        args.extend(["--search", cleaned_query])
    if owner:
        args.extend(["--owner", owner])
    if visibility:
        args.extend(["--visibility", visibility])
    for tag in tags or []:
        if tag.strip():
            args.extend(["--tag", tag.strip()])
    if action_status:
        args.extend(["--action-status", action_status])
    if include_actions:
        args.append("--show-actions")
    if starred:
        args.append("--starred")
    if mine:
        args.append("--mine")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

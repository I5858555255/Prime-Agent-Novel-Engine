from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


Action = Literal["list", "info", "status", "pull", "push", "install"]


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


def _require(value: str | None, name: str) -> str:
    if value is None or not value.strip():
        raise ValueError(f"{name} is required")
    return value.strip()


def _build_list_args(
    *,
    search: str,
    max_results: int,
    page: int,
    owner: str | None,
    visibility: str | None,
    tags: list[str] | None,
    action_status: str | None,
    sort: str,
    order: str,
    show_actions: bool,
    starred: bool,
    mine: bool,
) -> list[str]:
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
    if search.strip():
        args.extend(["--search", search.strip()])
    if owner:
        args.extend(["--owner", owner])
    if visibility:
        args.extend(["--visibility", visibility])
    for tag in tags or []:
        if tag.strip():
            args.extend(["--tag", tag.strip()])
    if action_status:
        args.extend(["--action-status", action_status])
    if show_actions:
        args.append("--show-actions")
    if starred:
        args.append("--starred")
    if mine:
        args.append("--mine")
    return args


async def run(
    action: Action = "list",
    env_id: str | None = None,
    env_ids: list[str] | None = None,
    search: str = "",
    max_results: int = 20,
    page: int = 1,
    owner: str | None = None,
    visibility: Literal["PUBLIC", "PRIVATE"] | None = None,
    tags: list[str] | None = None,
    action_status: Literal["SUCCESS", "FAILED", "RUNNING", "PENDING"] | None = None,
    sort: Literal["name", "created_at", "updated_at", "stars"] = "created_at",
    order: Literal["asc", "desc"] = "desc",
    show_actions: bool = True,
    starred: bool = False,
    mine: bool = False,
    target: str | None = None,
    version: str = "latest",
    path: str | None = None,
    name: str | None = None,
    team: str | None = None,
    package_manager: Literal["uv", "pip"] = "uv",
    no_upgrade: bool = False,
    prerelease: bool = False,
    auto_bump: bool = False,
    rc: bool = False,
    post: bool = False,
    timeout_seconds: float = 120.0,
) -> dict[str, object]:
    """Run a Prime environment CLI operation.

    Args:
        action: Operation to run: list, info, status, pull, push, or install.
        env_id: Single environment ID for info, status, pull, or push.
        env_ids: Environment IDs for install.
        search: Search term for list.
        max_results: Items per page for list.
        page: Page number for list.
        owner: Owner filter for list, or owner override for push.
        visibility: Visibility filter for list, or visibility for push.
        tags: Tag filters for list.
        action_status: Action status filter for list.
        sort: Sort key for list.
        order: Sort order for list.
        show_actions: Include action status in list output.
        starred: List only starred environments.
        mine: List only environments owned by the active account or team.
        target: Pull target directory.
        version: Version for info or pull.
        path: Local path for push or install.
        name: Name override for push.
        team: Team slug for push.
        package_manager: Package manager for install.
        no_upgrade: Do not upgrade existing packages during install.
        prerelease: Allow prerelease versions during install.
        auto_bump: Auto-bump patch version during push.
        rc: Bump or create a release-candidate version during push.
        post: Bump or create a post-release version during push.
        timeout_seconds: CLI timeout in seconds.

    Returns:
        A dictionary with command metadata and parsed JSON output when present.
    """
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if page < 1:
        raise ValueError("page must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    if action == "list":
        args = _build_list_args(
            search=search,
            max_results=max_results,
            page=page,
            owner=owner,
            visibility=visibility,
            tags=tags,
            action_status=action_status,
            sort=sort,
            order=order,
            show_actions=show_actions,
            starred=starred,
            mine=mine,
        )
    elif action == "info":
        args = ["env", "info", _require(env_id, "env_id"), "--version", version]
    elif action == "status":
        args = ["env", "status", _require(env_id, "env_id"), "--output", "json"]
    elif action == "pull":
        args = ["env", "pull", _require(env_id, "env_id"), "--version", version]
        if target:
            args.extend(["--target", target])
    elif action == "push":
        args = ["env", "push"]
        if env_id:
            args.append(env_id)
        if path:
            args.extend(["--path", path])
        if name:
            args.extend(["--name", name])
        if owner:
            args.extend(["--owner", owner])
        if team:
            args.extend(["--team", team])
        if visibility:
            args.extend(["--visibility", visibility])
        if auto_bump:
            args.append("--auto-bump")
        if rc:
            args.append("--rc")
        if post:
            args.append("--post")
    elif action == "install":
        cleaned_env_ids = [item.strip() for item in env_ids or [] if item.strip()]
        if not cleaned_env_ids:
            raise ValueError("env_ids is required for install")
        args = ["env", "install", *cleaned_env_ids, "--with", package_manager]
        if path:
            args.extend(["--path", path])
        if no_upgrade:
            args.append("--no-upgrade")
        if prerelease:
            args.append("--prerelease")
    else:
        raise ValueError(f"unsupported action: {action}")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

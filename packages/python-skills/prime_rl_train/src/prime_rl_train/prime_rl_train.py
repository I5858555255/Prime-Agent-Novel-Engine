from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


Action = Literal[
    "run",
    "list",
    "get",
    "logs",
    "metrics",
    "progress",
    "rollouts",
    "distributions",
    "checkpoints",
    "components",
    "usage",
    "models",
    "configs",
    "init",
    "stop",
    "delete",
    "restart",
]


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


def _append_optional(args: list[str], flag: str, value: object | None) -> None:
    if value is not None:
        args.extend([flag, str(value)])


async def run(
    action: Action = "list",
    config_path: str | None = None,
    run_id: str | None = None,
    env_vars: list[str] | None = None,
    env_file: str | None = None,
    yes: bool = False,
    skip_action_check: bool = False,
    team: str | None = None,
    max_results: int = 20,
    page: int = 1,
    output_json: bool = True,
    tail: int = 1000,
    follow: bool = False,
    raw_logs: bool = False,
    component: Literal["orchestrator", "env-server"] | None = None,
    env: str | None = None,
    min_step: int | None = None,
    max_step: int | None = None,
    limit: int | None = None,
    step: int | None = None,
    distribution_type: str | None = None,
    status: Literal["READY", "PENDING", "UPLOADING", "FAILED"] | None = None,
    watch: bool = False,
    interval_seconds: int = 30,
    output_path: str | None = None,
    force: bool = False,
    extra_args: list[str] | None = None,
    timeout_seconds: float = 300.0,
) -> dict[str, object]:
    """Run a Prime hosted RL training CLI operation.

    Args:
        action: Operation to run.
        config_path: TOML config path for run.
        run_id: Training run ID for run-specific operations.
        env_vars: Env vars/secrets for launch, as KEY=VALUE, KEY, or .env paths.
        env_file: .env file for launch.
        yes: Skip launch confirmation.
        skip_action_check: Launch even if environment action status failed.
        team: Team filter for list.
        max_results: Items per page for list and rollouts.
        page: Page number for list and rollouts.
        output_json: Request JSON output for commands that support it.
        tail: Log lines to fetch.
        follow: Follow log output.
        raw_logs: Return raw logs without formatting.
        component: Training pod component for logs.
        env: Env-server name for logs.
        min_step: Minimum step for metrics.
        max_step: Maximum step for metrics.
        limit: Maximum records for metrics.
        step: Step for rollouts or distributions.
        distribution_type: Distribution type for distributions.
        status: Checkpoint status filter.
        watch: Watch usage continuously.
        interval_seconds: Usage watch interval.
        output_path: Config output path for init.
        force: Force stop/delete/restart/init overwrite.
        extra_args: Additional raw args for train run.
        timeout_seconds: CLI timeout in seconds.

    Returns:
        A dictionary with command metadata and parsed JSON output when present.
    """
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if page < 1:
        raise ValueError("page must be at least 1")
    if tail < 1:
        raise ValueError("tail must be at least 1")
    if interval_seconds < 2:
        raise ValueError("interval_seconds must be at least 2")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    if action == "run":
        args = ["train", _require(config_path, "config_path")]
        for env_var in env_vars or []:
            if env_var.strip():
                args.extend(["--env-var", env_var.strip()])
        _append_optional(args, "--env-file", env_file)
        if output_json:
            args.extend(["--output", "json"])
        if skip_action_check:
            args.append("--skip-action-check")
        if yes:
            args.append("--yes")
        args.extend(extra_args or [])
    elif action == "list":
        args = ["train", "list", "--num", str(max_results), "--page", str(page)]
        _append_optional(args, "--team", team)
        if output_json:
            args.extend(["--output", "json"])
    elif action == "get":
        args = ["train", "get", _require(run_id, "run_id")]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "logs":
        args = ["train", "logs", _require(run_id, "run_id"), "--tail", str(tail)]
        _append_optional(args, "--component", component)
        _append_optional(args, "--env", env)
        if follow:
            args.append("--follow")
        if raw_logs:
            args.append("--raw")
    elif action == "metrics":
        args = ["train", "metrics", _require(run_id, "run_id")]
        _append_optional(args, "--min-step", min_step)
        _append_optional(args, "--max-step", max_step)
        _append_optional(args, "--limit", limit)
    elif action == "progress":
        args = ["train", "progress", _require(run_id, "run_id")]
    elif action == "rollouts":
        if step is None:
            raise ValueError("step is required for rollouts")
        args = [
            "train",
            "rollouts",
            _require(run_id, "run_id"),
            "--step",
            str(step),
            "--page",
            str(page),
            "--num",
            str(max_results),
        ]
    elif action == "distributions":
        args = ["train", "distributions", _require(run_id, "run_id")]
        _append_optional(args, "--type", distribution_type)
        _append_optional(args, "--step", step)
    elif action == "checkpoints":
        args = ["train", "checkpoints", _require(run_id, "run_id")]
        _append_optional(args, "--status", status)
        if output_json:
            args.extend(["--output", "json"])
    elif action == "components":
        args = ["train", "components", _require(run_id, "run_id")]
    elif action == "usage":
        args = ["train", "usage", _require(run_id, "run_id")]
        if output_json:
            args.extend(["--output", "json"])
        if watch:
            args.append("--watch")
            args.extend(["--interval", str(interval_seconds)])
    elif action == "models":
        args = ["train", "models"]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "configs":
        args = ["train", "configs"]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "init":
        args = ["train", "init"]
        if output_path:
            args.append(output_path)
        if force:
            args.append("--force")
    elif action in {"stop", "delete", "restart"}:
        args = ["train", action, _require(run_id, "run_id")]
        if force:
            args.append("--force")
    else:
        raise ValueError(f"unsupported action: {action}")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

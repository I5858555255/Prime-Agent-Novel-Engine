from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


Action = Literal[
    "gpu_types",
    "availability",
    "disks",
    "list",
    "history",
    "status",
    "create",
    "terminate",
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
    action: Action = "availability",
    pod_id: str | None = None,
    gpu_type: str | None = None,
    gpu_count: int | None = None,
    regions: str | None = None,
    socket: str | None = None,
    provider: str | None = None,
    disks: list[str] | None = None,
    group_similar: bool = True,
    limit: int = 100,
    offset: int = 0,
    watch: bool = False,
    id: str | None = None,
    cloud_id: str | None = None,
    name: str | None = None,
    disk_size: int | None = None,
    vcpus: int | None = None,
    memory: int | None = None,
    image: str | None = None,
    custom_template_id: str | None = None,
    team_id: str | None = None,
    env: list[str] | None = None,
    share_with_team: bool = False,
    yes: bool = False,
    output_json: bool = True,
    timeout_seconds: float = 300.0,
) -> dict[str, object]:
    """Run a Prime GPU availability or pod lifecycle operation.

    Args:
        action: Operation to run.
        pod_id: Pod ID for status or terminate.
        gpu_type: GPU type filter or create value.
        gpu_count: Number of GPUs for availability or create.
        regions: Availability region filter.
        socket: Availability socket filter.
        provider: Availability provider filter.
        disks: Disk IDs for availability filtering or pod attachment.
        group_similar: Group similar availability resources.
        limit: Number of pods/history rows to list.
        offset: Number of pods/history rows to skip.
        watch: Watch pod list output.
        id: Short availability ID for pod create.
        cloud_id: Cloud provider ID for pod create.
        name: Pod name for create.
        disk_size: Disk size in GB for create.
        vcpus: vCPU count for create.
        memory: Memory in GB for create.
        image: Image name for create.
        custom_template_id: Custom template ID for create.
        team_id: Team ID for create.
        env: Environment variables for create as KEY=value strings.
        share_with_team: Share created pod with team members.
        yes: Skip create or terminate confirmation prompts.
        output_json: Request JSON output for commands that support it.
        timeout_seconds: CLI timeout in seconds.

    Returns:
        A dictionary with command metadata and parsed JSON output when present.
    """
    if limit < 1:
        raise ValueError("limit must be at least 1")
    if offset < 0:
        raise ValueError("offset must be non-negative")
    if gpu_count is not None and gpu_count < 1:
        raise ValueError("gpu_count must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    if action == "gpu_types":
        args = ["availability", "gpu-types"]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "availability":
        args = ["availability", "list"]
        _append_optional(args, "--gpu-type", gpu_type)
        _append_optional(args, "--gpu-count", gpu_count)
        _append_optional(args, "--regions", regions)
        _append_optional(args, "--socket", socket)
        _append_optional(args, "--provider", provider)
        for disk in disks or []:
            if disk.strip():
                args.extend(["--disks", disk.strip()])
        args.append("--group-similar" if group_similar else "--no-group-similar")
        if output_json:
            args.extend(["--output", "json"])
    elif action == "disks":
        args = ["availability", "disks"]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "list":
        args = ["pods", "list", "--limit", str(limit), "--offset", str(offset)]
        if output_json:
            args.extend(["--output", "json"])
        if watch:
            args.append("--watch")
    elif action == "history":
        args = ["pods", "history", "--limit", str(limit), "--offset", str(offset)]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "status":
        args = ["pods", "status", _require(pod_id, "pod_id")]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "create":
        args = ["pods", "create"]
        _append_optional(args, "--id", id)
        _append_optional(args, "--cloud-id", cloud_id)
        _append_optional(args, "--gpu-type", gpu_type)
        _append_optional(args, "--gpu-count", gpu_count)
        _append_optional(args, "--name", name)
        _append_optional(args, "--disk-size", disk_size)
        _append_optional(args, "--vcpus", vcpus)
        _append_optional(args, "--memory", memory)
        _append_optional(args, "--image", image)
        _append_optional(args, "--custom-template-id", custom_template_id)
        _append_optional(args, "--team-id", team_id)
        for disk in disks or []:
            if disk.strip():
                args.extend(["--disks", disk.strip()])
        for item in env or []:
            if item.strip():
                args.extend(["--env", item.strip()])
        if share_with_team:
            args.append("--share-with-team")
        if yes:
            args.append("--yes")
    elif action == "terminate":
        args = ["pods", "terminate", _require(pod_id, "pod_id")]
        if yes:
            args.append("--yes")
    else:
        raise ValueError(f"unsupported action: {action}")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

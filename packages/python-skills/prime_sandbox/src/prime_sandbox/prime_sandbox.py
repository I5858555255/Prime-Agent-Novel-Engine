from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


Action = Literal[
    "list",
    "get",
    "logs",
    "create",
    "delete",
    "run",
    "upload",
    "download",
    "expose",
    "unexpose",
    "list_ports",
    "reset_cache",
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
    sandbox_id: str | None = None,
    sandbox_ids: list[str] | None = None,
    docker_image: str | None = None,
    command: list[str] | None = None,
    name: str | None = None,
    start_command: str | None = None,
    cpu_cores: float | None = None,
    memory_gb: float | None = None,
    disk_size_gb: float | None = None,
    gpu_count: int | None = None,
    gpu_type: str | None = None,
    vm: bool = False,
    network_access: bool = True,
    timeout_minutes: int | None = None,
    team_id: str | None = None,
    region: str | None = None,
    registry_credentials_id: str | None = None,
    env: list[str] | None = None,
    secrets: list[str] | None = None,
    labels: list[str] | None = None,
    guaranteed: bool = False,
    yes: bool = False,
    status: str | None = None,
    page: int = 1,
    max_results: int = 50,
    include_all: bool = False,
    all_users: bool = False,
    working_dir: str | None = None,
    command_timeout_seconds: int | None = None,
    local_file: str | None = None,
    remote_path: str | None = None,
    port: int | None = None,
    exposure_id: str | None = None,
    protocol: Literal["HTTP", "TCP"] = "HTTP",
    output_json: bool = True,
    timeout_seconds: float = 300.0,
) -> dict[str, object]:
    """Run a Prime sandbox lifecycle operation.

    Args:
        action: Operation to run.
        sandbox_id: Sandbox ID for get, logs, run, file, port, and delete ops.
        sandbox_ids: Sandbox IDs for delete.
        docker_image: Docker image or VM image for create.
        command: Command argv to execute in sandbox.
        name: Sandbox name for create, or exposed port name for expose.
        start_command: Container start command for create.
        cpu_cores: CPU cores for create.
        memory_gb: Memory in GB for create.
        disk_size_gb: Disk size in GB for create.
        gpu_count: GPU count for create.
        gpu_type: GPU type for create.
        vm: Create a VM-backed sandbox.
        network_access: Allow outbound internet access for create.
        timeout_minutes: Sandbox timeout in minutes for create.
        team_id: Team ID for create or list.
        region: Sandbox region for create.
        registry_credentials_id: Registry credentials ID for create.
        env: Environment variables as KEY=VALUE strings.
        secrets: Secrets as KEY=VALUE strings for create.
        labels: Labels for create, list, or delete-by-label.
        guaranteed: Request guaranteed CPU/memory scheduling for create.
        yes: Skip confirmation prompts for create, delete, and unexpose.
        status: Status filter for list.
        page: Page number for list.
        max_results: Items per page for list.
        include_all: Include terminated sandboxes for list, or delete all.
        all_users: Delete matching sandboxes across all team users.
        working_dir: Working directory for run.
        command_timeout_seconds: Command timeout for run.
        local_file: Local path for upload/download.
        remote_path: Remote path for upload/download.
        port: Port number for expose.
        exposure_id: Exposure ID for unexpose.
        protocol: Exposure protocol.
        output_json: Request JSON output for commands that support it.
        timeout_seconds: CLI timeout in seconds.

    Returns:
        A dictionary with command metadata and parsed JSON output when present.
    """
    if page < 1:
        raise ValueError("page must be at least 1")
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if gpu_count is not None and gpu_count < 0:
        raise ValueError("gpu_count must be non-negative")
    if port is not None and port < 1:
        raise ValueError("port must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    if action == "list":
        args = ["sandbox", "list", "--page", str(page), "--num", str(max_results)]
        _append_optional(args, "--team-id", team_id)
        _append_optional(args, "--status", status)
        for label in labels or []:
            if label.strip():
                args.extend(["--label", label.strip()])
        if include_all:
            args.append("--all")
        if output_json:
            args.extend(["--output", "json"])
    elif action == "get":
        args = ["sandbox", "get", _require(sandbox_id, "sandbox_id")]
        if output_json:
            args.extend(["--output", "json"])
    elif action == "logs":
        args = ["sandbox", "logs", _require(sandbox_id, "sandbox_id")]
    elif action == "create":
        args = ["sandbox", "create"]
        if docker_image:
            args.append(docker_image)
        _append_optional(args, "--name", name)
        _append_optional(args, "--start-command", start_command)
        _append_optional(args, "--cpu-cores", cpu_cores)
        _append_optional(args, "--memory-gb", memory_gb)
        _append_optional(args, "--disk-size-gb", disk_size_gb)
        _append_optional(args, "--gpu-count", gpu_count)
        _append_optional(args, "--gpu-type", gpu_type)
        if vm:
            args.append("--vm")
        args.append("--network-access" if network_access else "--no-network-access")
        _append_optional(args, "--timeout-minutes", timeout_minutes)
        _append_optional(args, "--team-id", team_id)
        _append_optional(args, "--region", region)
        _append_optional(args, "--registry-credentials-id", registry_credentials_id)
        for item in env or []:
            if item.strip():
                args.extend(["--env", item.strip()])
        for secret in secrets or []:
            if secret.strip():
                args.extend(["--secret", secret.strip()])
        for label in labels or []:
            if label.strip():
                args.extend(["--label", label.strip()])
        if guaranteed:
            args.append("--guaranteed")
        if yes:
            args.append("--yes")
    elif action == "delete":
        args = ["sandbox", "delete"]
        cleaned_ids = [item.strip() for item in sandbox_ids or [] if item.strip()]
        if sandbox_id:
            cleaned_ids.insert(0, sandbox_id.strip())
        args.extend(cleaned_ids)
        if include_all:
            args.append("--all")
        for label in labels or []:
            if label.strip():
                args.extend(["--label", label.strip()])
        args.append("--all-users" if all_users else "--only-mine")
        if yes:
            args.append("--yes")
        if not cleaned_ids and not include_all and not labels:
            raise ValueError("sandbox_id, sandbox_ids, labels, or include_all is required for delete")
    elif action == "run":
        cleaned_command = [part for part in command or [] if part]
        if not cleaned_command:
            raise ValueError("command is required for run")
        args = ["sandbox", "run", _require(sandbox_id, "sandbox_id")]
        _append_optional(args, "--working-dir", working_dir)
        for item in env or []:
            if item.strip():
                args.extend(["--env", item.strip()])
        _append_optional(args, "--timeout", command_timeout_seconds)
        args.append("--")
        args.extend(cleaned_command)
    elif action == "upload":
        args = [
            "sandbox",
            "upload",
            _require(sandbox_id, "sandbox_id"),
            _require(local_file, "local_file"),
            _require(remote_path, "remote_path"),
        ]
    elif action == "download":
        args = [
            "sandbox",
            "download",
            _require(sandbox_id, "sandbox_id"),
            _require(remote_path, "remote_path"),
            _require(local_file, "local_file"),
        ]
    elif action == "expose":
        if port is None:
            raise ValueError("port is required for expose")
        args = ["sandbox", "expose", _require(sandbox_id, "sandbox_id"), str(port)]
        _append_optional(args, "--name", name)
        args.extend(["--protocol", protocol])
        if output_json:
            args.extend(["--output", "json"])
    elif action == "unexpose":
        args = [
            "sandbox",
            "unexpose",
            _require(sandbox_id, "sandbox_id"),
            _require(exposure_id, "exposure_id"),
        ]
        if yes:
            args.append("--yes")
    elif action == "list_ports":
        args = ["sandbox", "list-ports"]
        if sandbox_id:
            args.append(sandbox_id)
        if output_json:
            args.extend(["--output", "json"])
    elif action == "reset_cache":
        args = ["sandbox", "reset-cache"]
    else:
        raise ValueError(f"unsupported action: {action}")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

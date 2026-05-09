from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from typing import Literal


Action = Literal["run", "list", "get", "samples", "logs", "stop", "push"]
Provider = Literal[
    "prime",
    "openrouter",
    "openai",
    "anthropic",
    "minimax",
    "deepseek",
    "glm",
    "local",
    "vllm",
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


def _build_run_args(
    *,
    environment: str | None,
    model: str | None,
    provider: str,
    env_args_json: str | None,
    num_examples: int | None,
    rollouts_per_example: int | None,
    max_concurrent: int | None,
    max_tokens: int | None,
    temperature: float | None,
    sampling_args_json: str | None,
    output_dir: str | None,
    save_results: bool,
    hosted: bool,
    follow: bool,
    timeout_minutes: int | None,
    poll_interval: float,
    allow_sandbox_access: bool,
    allow_instances_access: bool,
    allow_tunnel_access: bool,
    custom_secrets_json: str | None,
    eval_name: str | None,
    disable_tui: bool,
    extra_args: list[str] | None,
) -> list[str]:
    args = ["eval", "run", _require(environment, "environment")]
    _append_optional(args, "--model", model)
    if provider:
        args.extend(["--provider", provider])
    _append_optional(args, "--env-args", env_args_json)
    _append_optional(args, "--num-examples", num_examples)
    _append_optional(args, "--rollouts-per-example", rollouts_per_example)
    _append_optional(args, "--max-concurrent", max_concurrent)
    _append_optional(args, "--max-tokens", max_tokens)
    _append_optional(args, "--temperature", temperature)
    _append_optional(args, "--sampling-args", sampling_args_json)
    _append_optional(args, "--output-dir", output_dir)
    if save_results:
        args.append("--save-results")
    if disable_tui and not hosted:
        args.append("--disable-tui")
    if hosted:
        args.append("--hosted")
    if follow:
        args.append("--follow")
    _append_optional(args, "--timeout-minutes", timeout_minutes)
    if poll_interval != 5.0:
        args.extend(["--poll-interval", str(poll_interval)])
    if allow_sandbox_access:
        args.append("--allow-sandbox-access")
    if allow_instances_access:
        args.append("--allow-instances-access")
    if allow_tunnel_access:
        args.append("--allow-tunnel-access")
    _append_optional(args, "--custom-secrets", custom_secrets_json)
    _append_optional(args, "--eval-name", eval_name)
    args.extend(extra_args or [])
    return args


async def run(
    action: Action = "list",
    environment: str | None = None,
    eval_id: str | None = None,
    model: str | None = None,
    provider: Provider = "prime",
    env_args_json: str | None = None,
    num_examples: int | None = None,
    rollouts_per_example: int | None = None,
    max_concurrent: int | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    sampling_args_json: str | None = None,
    output_dir: str | None = None,
    save_results: bool = False,
    hosted: bool = True,
    follow: bool = False,
    timeout_minutes: int | None = None,
    poll_interval: float = 5.0,
    allow_sandbox_access: bool = False,
    allow_instances_access: bool = False,
    allow_tunnel_access: bool = False,
    custom_secrets_json: str | None = None,
    eval_name: str | None = None,
    disable_tui: bool = True,
    env_name: str | None = None,
    config_path: str | None = None,
    run_id: str | None = None,
    public: bool = False,
    max_results: int = 20,
    page: int = 1,
    tail: int = 1000,
    extra_args: list[str] | None = None,
    timeout_seconds: float = 300.0,
) -> dict[str, object]:
    """Run a Prime evaluation CLI operation.

    Args:
        action: Operation to run: run, list, get, samples, logs, stop, or push.
        environment: Environment module/name or eval config path for run.
        eval_id: Evaluation ID for get, samples, logs, stop, or push update.
        model: Model name for run.
        provider: Inference provider shorthand for run.
        env_args_json: JSON object string passed as --env-args.
        num_examples: Number of examples to evaluate.
        rollouts_per_example: Number of rollouts per example.
        max_concurrent: Maximum concurrent rollout count.
        max_tokens: Maximum tokens per completion.
        temperature: Sampling temperature.
        sampling_args_json: JSON object string passed as --sampling-args.
        output_dir: Local output directory for run.
        save_results: Save local eval results to disk.
        hosted: Run on Prime's hosted platform.
        follow: Follow hosted logs until completion.
        timeout_minutes: Hosted evaluation timeout in minutes.
        poll_interval: Hosted polling interval in seconds.
        allow_sandbox_access: Allow hosted eval sandbox access.
        allow_instances_access: Allow hosted eval instance access.
        allow_tunnel_access: Allow hosted eval tunnel access.
        custom_secrets_json: JSON object string for hosted eval secrets.
        eval_name: Hosted evaluation display name.
        disable_tui: Disable local Rich display for local runs.
        env_name: Environment filter for list or environment override for push.
        config_path: Local eval result directory for push.
        run_id: Training run ID to link during push.
        public: Make pushed evaluation public.
        max_results: Items per page for list and samples.
        page: Page number for list and samples.
        tail: Log lines to fetch for logs.
        extra_args: Additional raw prime eval run args.
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
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    if action == "run":
        args = _build_run_args(
            environment=environment,
            model=model,
            provider=provider,
            env_args_json=env_args_json,
            num_examples=num_examples,
            rollouts_per_example=rollouts_per_example,
            max_concurrent=max_concurrent,
            max_tokens=max_tokens,
            temperature=temperature,
            sampling_args_json=sampling_args_json,
            output_dir=output_dir,
            save_results=save_results,
            hosted=hosted,
            follow=follow,
            timeout_minutes=timeout_minutes,
            poll_interval=poll_interval,
            allow_sandbox_access=allow_sandbox_access,
            allow_instances_access=allow_instances_access,
            allow_tunnel_access=allow_tunnel_access,
            custom_secrets_json=custom_secrets_json,
            eval_name=eval_name,
            disable_tui=disable_tui,
            extra_args=extra_args,
        )
    elif action == "list":
        args = ["eval", "list", "--output", "json", "--num", str(max_results), "--page", str(page)]
        if env_name:
            args.extend(["--env", env_name])
    elif action == "get":
        args = ["eval", "get", _require(eval_id, "eval_id"), "--output", "json"]
    elif action == "samples":
        args = [
            "eval",
            "samples",
            _require(eval_id, "eval_id"),
            "--output",
            "json",
            "--num",
            str(max_results),
            "--page",
            str(page),
        ]
    elif action == "logs":
        args = ["eval", "logs", _require(eval_id, "eval_id"), "--tail", str(tail)]
        if follow:
            args.append("--follow")
        if poll_interval != 5.0:
            args.extend(["--poll-interval", str(poll_interval)])
    elif action == "stop":
        args = ["eval", "stop", _require(eval_id, "eval_id")]
    elif action == "push":
        args = ["eval", "push"]
        if config_path:
            args.append(config_path)
        if env_name:
            args.extend(["--env", env_name])
        if run_id:
            args.extend(["--run-id", run_id])
        if eval_id:
            args.extend(["--eval", eval_id])
        if eval_name:
            args.extend(["--name", eval_name])
        if public:
            args.append("--public")
        args.extend(["--output", "json"])
    else:
        raise ValueError(f"unsupported action: {action}")

    return await asyncio.to_thread(_run_prime, args, timeout_seconds)

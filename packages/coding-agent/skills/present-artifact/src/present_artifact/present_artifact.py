"""Thin kernel adapter for user-visible artifact presentation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from rlm import host_request


async def run(path: str, label: str | None = None) -> dict[str, Any]:
    """Present an on-disk artifact to the user without attaching it to the model.

    The Prime Agent host owns artifact inspection, capture, and rendering. This
    adapter only resolves an existing regular file and forwards its path and an
    optional display label.

    Args:
        path: Path to an existing regular file.
        label: Optional user-visible label.

    Returns:
        The host's compact presentation receipt.
    """
    if not isinstance(path, str):
        raise TypeError(f"path must be str, got {type(path).__name__}")
    if label is not None and not isinstance(label, str):
        raise TypeError(f"label must be str or None, got {type(label).__name__}")

    filepath = Path(path).expanduser().resolve()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    payload: dict[str, Any] = {"path": str(filepath)}
    if label is not None:
        payload["label"] = label
    return await host_request("artifact.present", payload)

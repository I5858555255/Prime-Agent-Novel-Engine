"""Prime Agent browser skill: control a shared browser from the kernel.

All browser state lives in the TypeScript host, which owns the single CDP
connection and assigns tabs to agents (each agent only ever sees its own
tabs). These functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent IPython kernel.

Usage pattern: `await browser.screenshot()` to look, `click_at_xy` to act,
`js()` to read the DOM, `cdp()` as the raw escape hatch. Models without
vision use `dom()` + `click_index()` instead of screenshots.
"""

from __future__ import annotations

import base64
import io
from typing import Any

from rlm import host_request

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Match the attach-image skill's caps so screenshots stay replay-friendly.
_MAX_ATTACHMENT_DATA_CHARS = 350_000
_MAX_ATTACHMENT_DIMENSION = 1200
_JPEG_QUALITIES = (82, 72, 60, 48, 36)


def _payload(**kwargs: Any) -> dict[str, Any]:
    """Build a request payload, dropping unset optional arguments."""
    return {key: value for key, value in kwargs.items() if value is not None}


def _require_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{name} must be a non-empty str, got {type(value).__name__}")
    return value


# ---------------------------------------------------------------------------
# Session / tab management
# ---------------------------------------------------------------------------


async def ensure_session() -> dict[str, Any]:
    """Ensure this agent owns a tab, creating a fresh one on first call.

    Never hijacks the user's current tab; use list_tabs(scope="all") +
    attach_tab() (main agent only) to work on a page the user already opened.
    """
    return await host_request("browser.ensure_session")


async def new_tab(url: str = "chrome://newtab/") -> dict[str, Any]:
    """Open a new tab owned by this agent and make it the agent's focus."""
    return await host_request("browser.new_tab", {"url": _require_str(url, "url")})


async def attach_tab(target_id: str) -> dict[str, Any]:
    """Adopt an existing user tab (main agent only; child agents are rejected).

    Adopted tabs are released — never closed — when this agent's session ends.
    """
    return await host_request("browser.attach_tab", {"target_id": _require_str(target_id, "target_id")})


async def close_tab(target_id: str | None = None) -> dict[str, Any]:
    """Close a tab this agent owns (defaults to its focused tab)."""
    return await host_request("browser.close_tab", _payload(target_id=target_id))


async def focus_tab(target_id: str) -> dict[str, Any]:
    """Move this agent's logical focus to another tab it owns.

    Targetless operations (screenshot, click_at_xy, js, ...) act on the focused
    tab. This is pure bookkeeping — the tab is never brought to the front.
    """
    return await host_request("browser.focus_tab", {"target_id": _require_str(target_id, "target_id")})


async def list_tabs(scope: str = "mine", include_active: bool = False) -> dict[str, Any]:
    """List tabs. scope="mine": only this agent's tabs. scope="all" (main
    agent only): also the user's unassigned tabs. With include_active=True,
    the tab the user is currently looking at is marked `active: true` (this
    briefly inspects each user tab and may trigger the browser's one-time
    remote-debugging consent popup — leave it off unless you need it)."""
    if scope not in ("mine", "all"):
        raise ValueError(f'scope must be "mine" or "all", got {scope!r}')
    return await host_request("browser.list_tabs", {"scope": scope, "include_active": include_active})


# ---------------------------------------------------------------------------
# Navigation & actions
# ---------------------------------------------------------------------------


async def goto_url(url: str, target_id: str | None = None) -> dict[str, Any]:
    """Navigate a tab (default: this agent's primary tab) to `url`."""
    return await host_request("browser.goto_url", _payload(url=_require_str(url, "url"), target_id=target_id))


async def click_at_xy(x: float, y: float, button: str = "left", clicks: int = 1, target_id: str | None = None) -> dict[str, Any]:
    """Click at viewport coordinates (CSS pixels, as read off a screenshot or dom() output)."""
    return await host_request(
        "browser.click_at_xy",
        _payload(x=x, y=y, button=button, clicks=clicks, target_id=target_id),
    )


async def type_text(text: str, target_id: str | None = None) -> dict[str, Any]:
    """Type text into the currently focused element (trusted input events)."""
    return await host_request("browser.type_text", _payload(text=_require_str(text, "text"), target_id=target_id))


async def press_key(key: str, modifiers: list[str] | None = None, target_id: str | None = None) -> dict[str, Any]:
    """Press a named key (enter, tab, escape, backspace, delete, arrows, home,
    end, pageup, pagedown, space) or a single character. modifiers: subset of
    ["ctrl", "shift", "alt", "cmd"]."""
    return await host_request(
        "browser.press_key",
        _payload(key=_require_str(key, "key"), modifiers=modifiers, target_id=target_id),
    )


async def scroll(
    x: float | None = None,
    y: float | None = None,
    dy: float = 600,
    dx: float = 0,
    target_id: str | None = None,
) -> dict[str, Any]:
    """Scroll the page (positive dy = down). JS-based: works on background tabs.

    With x/y, scrolls the scrollable container under that point; otherwise the
    main document. Returns the new scroll position.
    """
    return await host_request("browser.scroll", _payload(x=x, y=y, dy=dy, dx=dx, target_id=target_id))


async def reconnect() -> dict[str, Any]:
    """Forget the current browser connection and pick a new one.

    Use when the user asks to switch browsers (e.g. from a managed Chromium to
    their own Chrome). The connection-choice prompt is shown to the user again.
    """
    return await host_request("browser.reconnect")


async def fill_input(selector: str, text: str, target_id: str | None = None) -> dict[str, Any]:
    """Focus a CSS-selector element, clear it, and type `text` with trusted events."""
    return await host_request(
        "browser.fill_input",
        _payload(selector=_require_str(selector, "selector"), text=text, target_id=target_id),
    )


# ---------------------------------------------------------------------------
# Observation
# ---------------------------------------------------------------------------


async def js(expression: str, target_id: str | None = None) -> Any:
    """Evaluate JavaScript in the page and return the result value.

    Top-level `return` is auto-wrapped in an async IIFE; promises are awaited.
    """
    result = await host_request("browser.js", _payload(expression=_require_str(expression, "expression"), target_id=target_id))
    return result.get("result")


async def page_info(target_id: str | None = None) -> dict[str, Any]:
    """Return {url, title, viewport w/h, scroll x/y, page w/h} — the cheapest liveness check."""
    return await host_request("browser.page_info", _payload(target_id=target_id))


async def screenshot(target_id: str | None = None, quality: int = 70) -> dict[str, Any]:
    """Take a JPEG screenshot and attach it to the model's context as an image.

    When the current model has no vision capability this does NOT capture an
    image; it returns {"vision_unsupported": True, "hint": ...} — use dom()
    and click_index() on such models.
    """
    result = await host_request("browser.screenshot", _payload(target_id=target_id, quality=quality))
    if result.get("vision_unsupported"):
        return result
    data_b64 = result.get("data")
    if not isinstance(data_b64, str) or not data_b64:
        raise RuntimeError("browser.screenshot returned no image data")
    emitted_b64, note = _compress_for_attachment(data_b64)
    _emit_attachment(emitted_b64, result.get("mime_type", "image/jpeg"))
    return {"attached": True, "note": note}


async def dom(max_elements: int = 100, target_id: str | None = None) -> dict[str, Any]:
    """List the viewport's interactive elements as indexed text lines.

    Returns {url, title, viewport, elements_text, scrollables, ...}. The index
    [i] in elements_text feeds click_index(i)/fill_index(i, text). Re-run after
    navigation or major page changes — indexes go stale.
    """
    return await host_request("browser.dom", _payload(max_elements=max_elements, target_id=target_id))


async def click_index(index: int, target_id: str | None = None) -> dict[str, Any]:
    """Click element [index] from the most recent dom() snapshot."""
    if not isinstance(index, int):
        raise TypeError(f"index must be int, got {type(index).__name__}")
    return await host_request("browser.click_index", _payload(index=index, target_id=target_id))


async def fill_index(index: int, text: str, target_id: str | None = None) -> dict[str, Any]:
    """Click element [index] from the last dom() snapshot, clear it, and type `text`."""
    if not isinstance(index, int):
        raise TypeError(f"index must be int, got {type(index).__name__}")
    return await host_request("browser.fill_index", _payload(index=index, text=text, target_id=target_id))


async def drain_events() -> list[dict[str, Any]]:
    """Drain this agent's buffered CDP events (network, page lifecycle, dialogs)."""
    result = await host_request("browser.drain_events")
    events = result.get("events")
    return events if isinstance(events, list) else []


async def cdp(method: str, params: dict[str, Any] | None = None, target_id: str | None = None) -> Any:
    """Raw CDP escape hatch: run any Domain.method against this agent's tab."""
    result = await host_request(
        "browser.cdp",
        _payload(method=_require_str(method, "method"), params=params, target_id=target_id),
    )
    return result.get("result")


# ---------------------------------------------------------------------------
# Screenshot attachment (mirrors the attach-image skill's compression)
# ---------------------------------------------------------------------------


def _compress_for_attachment(data_b64: str) -> tuple[str, str]:
    raw = base64.b64decode(data_b64)
    if len(data_b64) <= _MAX_ATTACHMENT_DATA_CHARS:
        return data_b64, "original"
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError("browser skill needs Pillow to resize screenshots before attaching them.") from error

    image = Image.open(io.BytesIO(raw)).convert("RGB")
    original_width, original_height = image.size
    scale = min(1.0, _MAX_ATTACHMENT_DIMENSION / max(original_width, original_height))
    width = max(1, round(original_width * scale))
    height = max(1, round(original_height * scale))
    while True:
        resized = image.resize((width, height), Image.Resampling.LANCZOS)
        for jpeg_quality in _JPEG_QUALITIES:
            buffer = io.BytesIO()
            resized.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
            candidate = base64.b64encode(buffer.getvalue()).decode("ascii")
            if len(candidate) <= _MAX_ATTACHMENT_DATA_CHARS:
                return candidate, f"original {original_width}x{original_height}; attached {width}x{height} JPEG q{jpeg_quality}"
        next_width = max(1, int(width * 0.75))
        next_height = max(1, int(height * 0.75))
        if next_width == width and next_height == height:
            raise ValueError("screenshot could not be compressed below the attachment size cap")
        width, height = next_width, next_height


def _emit_attachment(data_b64: str, mime_type: str) -> None:
    from IPython.display import display

    display(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64},
            "text/plain": "Browser screenshot attached to context.",
        },
        raw=True,
    )

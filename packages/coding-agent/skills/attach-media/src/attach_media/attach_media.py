"""Load on-disk images into the model's context as multimodal attachments.

Each image is base64-encoded and streamed to the TypeScript host via
`display_data`, where it becomes an image content block on this tool's result —
the same path a pasted image takes. The model then *sees* the image. This is
distinct from opening an image with PIL in the kernel, which only lets you
compute over its bytes/pixels.
"""

from __future__ import annotations

import base64
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Anthropic/most providers accept up to ~5MB per image. Cap the raw bytes well
# under that so the base64 payload stays within range.
_MAX_IMAGE_BYTES = 3_500_000

# (mime_type, magic-byte prefix). Matches IMAGE_MIME_TYPES in src/utils/mime.ts.
_IMAGE_SIGNATURES = (
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
)


def _detect_image_mime(data: bytes) -> str | None:
    for mime, prefix in _IMAGE_SIGNATURES:
        if data.startswith(prefix):
            return mime
    # WebP: "RIFF"<4 size bytes>"WEBP"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _emit_attachment(path: str, mime_type: str, data_b64: str) -> None:
    from IPython.display import display

    display(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64, "path": path},
            "text/plain": f"Loaded image into context: {path}",
        },
        raw=True,
    )


async def run(*paths: str) -> str:
    """Load one or more on-disk images into the model's context as attachments.

    Use this when the model needs to actually SEE an image file — a screenshot,
    diagram, chart, photo, or scanned page. The image is sent to the model as a
    viewable attachment (the same way a pasted image is).

    Do NOT use this for programmatic image analysis (reading pixels, cropping,
    resizing, hashing, measuring colors). For that, open the file with PIL in
    the kernel instead.

    Args:
        *paths: One or more image paths. Relative, absolute, or `~`-prefixed.
            Supported formats: PNG, JPEG, GIF, WebP. Other types (PDF, audio,
            video) are not supported and raise an error.

    Returns:
        A short confirmation listing the images loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist.
        ValueError: If a file is not a supported image or is too large.
        RuntimeError: If the current model cannot accept images.
    """
    if not paths:
        raise ValueError("attach_media requires at least one image path")

    from rlm import host_request

    info = await host_request("model.info")
    if "image" not in info.get("input", []):
        model_id = info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} is not vision-capable, so it cannot load images into context. "
            "Switch to a multimodal model and try again."
        )

    loaded: list[str] = []
    for path in paths:
        filepath = Path(path).expanduser()
        if not filepath.exists():
            raise FileNotFoundError(f"{path} not found")
        data = filepath.read_bytes()
        mime = _detect_image_mime(data)
        if mime is None:
            raise ValueError(
                f"{path} is not a supported image (PNG, JPEG, GIF, WebP). "
                "Only images can be loaded into context; open other files in the kernel instead."
            )
        if len(data) > _MAX_IMAGE_BYTES:
            raise ValueError(
                f"{path} is {len(data) // 1_000_000}MB; images must be under "
                f"{_MAX_IMAGE_BYTES // 1_000_000}MB. Resize it (e.g. with PIL) first."
            )
        _emit_attachment(str(filepath), mime, base64.b64encode(data).decode("ascii"))
        loaded.append(path)

    return f"Loaded {len(loaded)} image(s) into context: {', '.join(loaded)}"

"""Stateful Codex-native image generation workflow."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import shutil
import stat as stat_module
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import unquote, urlparse

from rlm import host_request

_SCHEMA_VERSION = 1
_STORAGE_DIRECTORY = "codex-image"
_MAX_BRIEF_CHARS = 20_000
_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_IMAGE_PIXELS = 100_000_000
_MAX_VERSIONS_PER_WORKFLOW = 100
_MAX_REFERENCES = 10
_MAX_TIMEOUT_SECONDS = 1_800.0
_DEFAULT_TIMEOUT_SECONDS = 600.0
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_WORKFLOW_ID_PATTERN = re.compile(r"^img-[0-9a-f]{32}$")
_VERSION_DIRECTORY_PATTERN = re.compile(r"^v([0-9]{4})$")
_QUOTED_IMAGE_PATH_PATTERN = re.compile(
    r"""["'`](.+?\.(?:png|jpe?g|gif|webp))["'`]""", re.IGNORECASE
)
_MARKDOWN_IMAGE_PATH_PATTERN = re.compile(
    r"!?\[[^\]]*\]\((.+?\.(?:png|jpe?g|gif|webp))\)", re.IGNORECASE
)

CodexCommand = str | Sequence[str] | None


def _session_directory() -> Path:
    raw = os.environ.get("RLM_SESSION_DIR")
    if raw is None or not raw.strip():
        raise RuntimeError(
            "codex_image requires RLM_SESSION_DIR; start it from a persisted Prime Agent session."
        )
    session_directory = Path(raw).expanduser().resolve()
    if not session_directory.is_dir():
        raise RuntimeError(
            f"RLM_SESSION_DIR is not an existing directory: {session_directory}"
        )
    return session_directory


def _storage_root(*, create: bool) -> Path:
    session_directory = _session_directory()
    root = session_directory / _STORAGE_DIRECTORY
    if create:
        root.mkdir(mode=0o700, parents=False, exist_ok=True)
    if root.exists():
        resolved_root = root.resolve()
        try:
            resolved_root.relative_to(session_directory)
        except ValueError as error:
            raise RuntimeError("codex_image storage escapes RLM_SESSION_DIR") from error
        if not resolved_root.is_dir():
            raise RuntimeError(f"codex_image storage is not a directory: {resolved_root}")
        return resolved_root
    return root


def _validate_workflow_id(workflow_id: str) -> str:
    if not isinstance(workflow_id, str):
        raise TypeError(
            f"workflow_id must be str, got {type(workflow_id).__name__}"
        )
    if not _WORKFLOW_ID_PATTERN.fullmatch(workflow_id):
        raise ValueError("workflow_id is not a codex_image workflow ID")
    return workflow_id


def _workflow_directory(workflow_id: str, *, must_exist: bool) -> Path:
    validated_id = _validate_workflow_id(workflow_id)
    root = _storage_root(create=False)
    candidate = root / validated_id
    if must_exist and not candidate.is_dir():
        raise FileNotFoundError(f"codex_image workflow not found: {validated_id}")
    if candidate.exists():
        resolved = candidate.resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError as error:
            raise RuntimeError("codex_image workflow escapes session storage") from error
        if not resolved.is_dir():
            raise RuntimeError(f"codex_image workflow is not a directory: {validated_id}")
        return resolved
    return candidate


def _validate_brief(brief: str) -> str:
    if not isinstance(brief, str):
        raise TypeError(f"brief must be str, got {type(brief).__name__}")
    normalized = brief.strip()
    if not normalized:
        raise ValueError("brief must not be empty")
    if len(normalized) > _MAX_BRIEF_CHARS:
        raise ValueError(f"brief must be at most {_MAX_BRIEF_CHARS} characters")
    return normalized


def _validate_kind(kind: str) -> str:
    if not isinstance(kind, str):
        raise TypeError(f"kind must be str, got {type(kind).__name__}")
    if kind not in {"image", "icon", "mockup"}:
        raise ValueError('kind must be "image", "icon", or "mockup"')
    return kind


def _validate_label(label: str | None) -> str | None:
    if label is None:
        return None
    if not isinstance(label, str):
        raise TypeError(f"label must be str or None, got {type(label).__name__}")
    normalized = label.strip()
    if not normalized:
        raise ValueError("label must not be empty")
    if len(normalized) > 200:
        raise ValueError("label must be at most 200 characters")
    return normalized


def _validate_timeout(timeout_seconds: float) -> float:
    if isinstance(timeout_seconds, bool) or not isinstance(
        timeout_seconds, (int, float)
    ):
        raise TypeError(
            "timeout_seconds must be a positive number, got "
            f"{type(timeout_seconds).__name__}"
        )
    normalized = float(timeout_seconds)
    if normalized <= 0 or normalized > _MAX_TIMEOUT_SECONDS:
        raise ValueError(
            f"timeout_seconds must be greater than 0 and at most {_MAX_TIMEOUT_SECONDS:g}"
        )
    return normalized


def _resolve_command(command: CodexCommand) -> list[str]:
    configured: str | Sequence[str]
    if command is None:
        configured = os.environ.get("CODEX_IMAGE_COMMAND", "codex")
    else:
        configured = command

    if isinstance(configured, str):
        arguments = shlex.split(configured, posix=os.name != "nt")
        if os.name == "nt":
            arguments = [
                argument[1:-1]
                if len(argument) >= 2 and argument[0] == argument[-1] and argument[0] in {'"', "'"}
                else argument
                for argument in arguments
            ]
    elif isinstance(configured, Sequence):
        arguments = list(configured)
    else:
        raise TypeError(
            f"command must be str, a sequence of str, or None; got {type(configured).__name__}"
        )

    if not arguments or any(
        not isinstance(argument, str) or not argument for argument in arguments
    ):
        raise ValueError("Codex command must contain one or more non-empty strings")

    executable = shutil.which(arguments[0])
    if executable is None:
        raise RuntimeError(
            f"Codex CLI not found: {arguments[0]!r}. Install Codex, add it to PATH, "
            "or configure CODEX_IMAGE_COMMAND."
        )
    arguments[0] = executable
    return arguments


def _initial_prompt(
    brief: str, kind: str, output_directory: Path, reference_count: int
) -> str:
    if kind != "mockup":
        composition = (
            f"Create exactly one final {kind} image. Do not make a grid, contact sheet, "
            "or alternate directions."
        )
    else:
        composition = (
            "Create exactly one final mockup comparison-sheet image containing three "
            "visually distinct directions, clearly labeled A, B, and C. Do not create "
            "three separate image files."
        )
    reference_instruction = (
        f"Use the {reference_count} attached reference image(s) as visual context."
        if reference_count
        else "No external reference image is attached."
    )
    return f"""Use Codex's native image generation tool (imagegen) for this task.
Do not draw the requested asset with code, SVG, HTML, canvas, Pillow, or any procedural fallback.
{composition}
{reference_instruction}
Prefer the session staging directory below when choosing an output location. The native
image tool may instead save under Codex's generated_images directory; do not recreate the
image with code just to relocate it. Always emit/report the exact native raster output path
in the JSON event stream.
Staging directory (JSON): {json.dumps(str(output_directory))}

Original brief:
{brief}
"""


def _refinement_prompt(
    brief: str,
    kind: str,
    previous_image: Path,
    output_directory: Path,
) -> str:
    if kind != "mockup":
        composition = (
            f"Return exactly one refined {kind} image, not a grid or a set of alternatives."
        )
    else:
        composition = (
            "Return exactly one refined comparison-sheet image with three clearly "
            "labeled directions A, B, and C, not three separate files."
        )
    return f"""Continue this same image-generation thread and use Codex's native image generation tool (imagegen).
Refine the preceding version using the attached previous image as the visual source.
Do not draw the asset with code, SVG, HTML, canvas, Pillow, or any procedural fallback.
{composition}
Previous version (read-only): {previous_image}
Do not overwrite the previous image. Prefer the session staging directory below when
choosing an output location. The native image tool may instead save under Codex's
generated_images directory; do not recreate the image with code just to relocate it.
Always emit/report the exact native raster output path in the JSON event stream.
Staging directory (JSON): {json.dumps(str(output_directory))}

Requested refinement:
{brief}
"""


def _json_event_error(events: Sequence[dict[str, Any]]) -> str | None:
    for event in events:
        event_type = event.get("type")
        if event_type not in {"error", "turn.failed", "item.failed"}:
            continue
        message = event.get("message") or event.get("error") or event
        if isinstance(message, str):
            return message
        return json.dumps(message, sort_keys=True)
    return None


def _format_cli_failure(details: str) -> RuntimeError:
    normalized = details.strip()
    lowered = normalized.lower()
    if any(
        marker in lowered
        for marker in (
            "not authenticated",
            "authentication",
            "unauthorized",
            "log in",
            "login required",
            "api key",
        )
    ):
        return RuntimeError(
            "Codex authentication failed. Run `codex login` or configure Codex "
            f"credentials, then retry. {normalized[-1000:]}"
        )
    if not normalized:
        normalized = "Codex exited without an error message"
    return RuntimeError(f"Codex image generation failed: {normalized[-2000:]}")


async def _run_codex(
    arguments: Sequence[str],
    prompt: str,
    cwd: Path,
    timeout_seconds: float,
) -> list[dict[str, Any]]:
    try:
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=str(cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as error:
        raise RuntimeError(f"Codex CLI not found: {arguments[0]!r}") from error
    except OSError as error:
        raise RuntimeError(f"Could not start Codex CLI: {error}") from error

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(prompt.encode("utf-8")), timeout=timeout_seconds
        )
    except asyncio.TimeoutError as error:
        process.kill()
        await process.communicate()
        raise TimeoutError(
            f"Codex image generation timed out after {timeout_seconds:g} seconds"
        ) from error
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.communicate()
        raise

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    events: list[dict[str, Any]] = []
    invalid_lines: list[str] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            invalid_lines.append(stripped)
            continue
        if isinstance(value, dict):
            events.append(value)

    if process.returncode != 0:
        details = stderr or "\n".join(invalid_lines) or stdout
        raise _format_cli_failure(
            f"exit code {process.returncode}: {details}".strip()
        )

    event_error = _json_event_error(events)
    if event_error is not None:
        raise _format_cli_failure(event_error)
    return events


def _walk_json_strings(value: Any, key: str = ""):
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            yield from _walk_json_strings(child_value, str(child_key))
    elif isinstance(value, list):
        for child_value in value:
            yield from _walk_json_strings(child_value, key)
    elif isinstance(value, str):
        yield key, value


def _extract_thread_id(events: Sequence[dict[str, Any]]) -> str | None:
    thread_ids: list[str] = []
    for event in events:
        for key, value in _walk_json_strings(event):
            if key.lower() not in {"thread_id", "threadid"}:
                continue
            normalized = value.strip()
            if normalized and normalized not in thread_ids:
                thread_ids.append(normalized)
    return thread_ids[-1] if thread_ids else None


def _codex_generated_images_root() -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    return (codex_home / "generated_images").resolve()


def _possible_path_strings(value: str, allowed_roots: Sequence[Path]) -> list[str]:
    candidates = [value.strip()]
    candidates.extend(match.group(1).strip() for match in _QUOTED_IMAGE_PATH_PATTERN.finditer(value))
    candidates.extend(match.group(1).strip() for match in _MARKDOWN_IMAGE_PATH_PATTERN.finditer(value))
    for allowed_root in allowed_roots:
        path_start = value.find(str(allowed_root))
        if path_start < 0:
            continue
        path_text = value[path_start:]
        image_suffix = re.search(r"\.(?:png|jpe?g|gif|webp)", path_text, re.IGNORECASE)
        if image_suffix is not None:
            candidates.append(path_text[: image_suffix.end()])
    result: list[str] = []
    for candidate in candidates:
        candidate = candidate.strip().strip("\"'`")
        if candidate.startswith("file://"):
            parsed = urlparse(candidate)
            candidate = unquote(parsed.path)
            if parsed.netloc and os.name == "nt":
                candidate = f"//{parsed.netloc}{candidate}"
            elif os.name == "nt" and re.match(r"^/[A-Za-z]:/", candidate):
                candidate = candidate[1:]
        if candidate and candidate not in result:
            result.append(candidate)
    return result


def _candidate_path(
    raw_path: str,
    run_directory: Path,
    process_directory: Path,
    allowed_roots: Sequence[Path],
    started_at_ns: int,
) -> Path | None:
    raw_candidate = Path(raw_path).expanduser()
    candidates = (
        [raw_candidate]
        if raw_candidate.is_absolute()
        else [process_directory / raw_candidate, run_directory / raw_candidate]
    )
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if not any(
                resolved.is_relative_to(allowed_root)
                for allowed_root in allowed_roots
            ):
                continue
            image_stat = resolved.stat()
        except (OSError, ValueError):
            continue
        if resolved.suffix.lower() not in _IMAGE_EXTENSIONS or not resolved.is_file():
            continue
        # Files explicitly reported by this invocation must not predate it. Keep
        # a small tolerance for filesystems with coarse timestamp resolution.
        if image_stat.st_mtime_ns + 2_000_000_000 < started_at_ns:
            continue
        return resolved
    return None


def _extract_output_path(
    events: Sequence[dict[str, Any]],
    run_directory: Path,
    process_directory: Path,
    started_at_ns: int,
) -> Path:
    allowed_roots = [process_directory.resolve(), _codex_generated_images_root()]
    candidates: list[Path] = []
    for event in events:
        for key, value in _walk_json_strings(event):
            key_lower = key.lower()
            if not any(
                marker in key_lower
                for marker in ("path", "output", "image", "result", "message", "text")
            ):
                continue
            for raw_path in _possible_path_strings(value, allowed_roots):
                candidate = _candidate_path(
                    raw_path,
                    run_directory,
                    process_directory,
                    allowed_roots,
                    started_at_ns,
                )
                if candidate is not None and candidate not in candidates:
                    candidates.append(candidate)
    if not candidates:
        raise RuntimeError(
            "Codex completed without reporting a generated image path created by this "
            "invocation in the session staging directory or Codex generated-images store"
        )
    return candidates[-1]


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    offset = 2
    while offset + 9 < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }:
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None


def _raster_properties(
    data: bytes, mime_type: str
) -> tuple[int | None, int | None, bool | None]:
    if mime_type == "image/png" and len(data) >= 26:
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        color_type = data[25]
        return width, height, color_type in {4, 6} or b"tRNS" in data
    if mime_type == "image/gif" and len(data) >= 10:
        width = int.from_bytes(data[6:8], "little")
        height = int.from_bytes(data[8:10], "little")
        transparency = any(
            data[index + 3] & 1
            for index in range(len(data) - 7)
            if data[index : index + 3] == b"\x21\xf9\x04"
        )
        return width, height, transparency
    if mime_type == "image/jpeg":
        dimensions = _jpeg_dimensions(data)
        return (*dimensions, False) if dimensions else (None, None, False)
    if mime_type == "image/webp":
        if data[12:16] == b"VP8X" and len(data) >= 30:
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return width, height, bool(data[20] & 0x10)
        if data[12:16] == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1, bool(bits & (1 << 28))
        frame_header = data.find(b"\x9d\x01\x2a")
        if frame_header >= 0 and frame_header + 7 <= len(data):
            width = int.from_bytes(data[frame_header + 3 : frame_header + 5], "little") & 0x3FFF
            height = int.from_bytes(data[frame_header + 5 : frame_header + 7], "little") & 0x3FFF
            return width, height, b"ALPH" in data
    return None, None, None


def _detect_image(
    path: Path,
) -> tuple[str, str, int, str, int | None, int | None, bool | None]:
    data = path.read_bytes()
    size = len(data)
    if size <= 0:
        raise RuntimeError(f"Codex generated an empty image: {path}")
    if size > _MAX_IMAGE_BYTES:
        raise RuntimeError(
            f"Codex generated a {size}-byte image; the limit is {_MAX_IMAGE_BYTES} bytes"
        )
    header = data[:16]
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        mime_type, extension = "image/png", ".png"
    elif header.startswith(b"\xff\xd8\xff"):
        mime_type, extension = "image/jpeg", ".jpg"
    elif header.startswith((b"GIF87a", b"GIF89a")):
        mime_type, extension = "image/gif", ".gif"
    elif header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        mime_type, extension = "image/webp", ".webp"
    else:
        raise RuntimeError(
            f"Codex reported an unsupported or invalid raster image: {path}"
        )
    width, height, has_alpha = _raster_properties(data, mime_type)
    if width is not None and height is not None:
        if width <= 0 or height <= 0 or width * height > _MAX_IMAGE_PIXELS:
            raise RuntimeError(
                f"Codex generated invalid or oversized dimensions {width}x{height}: {path}"
            )
    digest = hashlib.sha256(data).hexdigest()
    return mime_type, extension, size, digest, width, height, has_alpha


def _reserve_version_directory(workflow_directory: Path) -> tuple[int, Path]:
    versions_directory = workflow_directory / "versions"
    versions_directory.mkdir(mode=0o700, exist_ok=True)
    existing_numbers = []
    for child in versions_directory.iterdir():
        match = _VERSION_DIRECTORY_PATTERN.fullmatch(child.name)
        if match:
            existing_numbers.append(int(match.group(1)))
    next_number = max(existing_numbers, default=0) + 1
    while next_number <= _MAX_VERSIONS_PER_WORKFLOW:
        version_directory = versions_directory / f"v{next_number:04d}"
        try:
            version_directory.mkdir(mode=0o700)
            return next_number, version_directory
        except FileExistsError:
            next_number += 1
    raise RuntimeError(
        f"codex_image workflows are limited to {_MAX_VERSIONS_PER_WORKFLOW} versions"
    )


def _remove_tree(path: Path) -> None:
    def handle_readonly(function, failing_path, _error_info):
        os.chmod(failing_path, stat_module.S_IWRITE | stat_module.S_IREAD)
        function(failing_path)

    try:
        shutil.rmtree(path, onerror=handle_readonly)
    except OSError:
        # Cleanup is best effort and must not replace the operation's real error.
        pass


def _atomic_copy_new(source: Path, destination: Path) -> None:
    temporary = destination.parent / f".{destination.name}.{uuid.uuid4().hex}.tmp"
    try:
        with source.open("rb") as source_file, temporary.open("xb") as target_file:
            shutil.copyfileobj(source_file, target_file, length=1024 * 1024)
            target_file.flush()
            os.fsync(target_file.fileno())
        if destination.exists():
            raise FileExistsError(f"immutable destination already exists: {destination}")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_references(
    workflow_directory: Path,
    references: Sequence[str | os.PathLike[str]],
) -> list[dict[str, Any]]:
    if isinstance(references, (str, bytes, os.PathLike)):
        raise TypeError("references must be a sequence of paths, not a single path")
    if not isinstance(references, Sequence):
        raise TypeError(
            f"references must be a sequence of paths, got {type(references).__name__}"
        )
    if len(references) > _MAX_REFERENCES:
        raise ValueError(f"references supports at most {_MAX_REFERENCES} images")

    references_directory = workflow_directory / "references"
    records: list[dict[str, Any]] = []
    for index, raw_reference in enumerate(references, start=1):
        if not isinstance(raw_reference, (str, os.PathLike)):
            raise TypeError(
                "each reference must be str or path-like, got "
                f"{type(raw_reference).__name__}"
            )
        source = Path(raw_reference).expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(f"reference is not an existing regular file: {source}")
        mime_type, extension, size, sha256, width, height, has_alpha = _detect_image(source)
        references_directory.mkdir(mode=0o700, exist_ok=True)
        destination = references_directory / f"reference-{index:02d}{extension}"
        _atomic_copy_new(source, destination)
        copied_mime_type, _, copied_size, copied_sha256, copied_width, copied_height, copied_has_alpha = _detect_image(
            destination
        )
        if (
            copied_size,
            copied_sha256,
            copied_width,
            copied_height,
            copied_has_alpha,
        ) != (size, sha256, width, height, has_alpha):
            raise RuntimeError(f"reference changed while it was being captured: {source}")
        os.chmod(destination, 0o444)
        records.append(
            {
                "file": str(destination.relative_to(workflow_directory)),
                "original_name": source.name,
                "mime_type": copied_mime_type,
                "bytes": copied_size,
                "sha256": copied_sha256,
                "width": copied_width,
                "height": copied_height,
                "has_alpha": copied_has_alpha,
            }
        )
    return records


def _reference_paths(
    workflow_directory: Path, references: Sequence[dict[str, Any]]
) -> list[Path]:
    paths: list[Path] = []
    for reference in references:
        raw_file = reference.get("file")
        if not isinstance(raw_file, str):
            raise RuntimeError("Invalid codex_image reference manifest")
        path = (workflow_directory / raw_file).resolve()
        try:
            path.relative_to(workflow_directory.resolve())
        except ValueError as error:
            raise RuntimeError("codex_image reference escapes workflow storage") from error
        if not path.is_file():
            raise RuntimeError(f"codex_image reference is missing: {path}")
        paths.append(path)
    return paths


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as manifest_file:
            json.dump(manifest, manifest_file, indent=2, sort_keys=True)
            manifest_file.write("\n")
            manifest_file.flush()
            os.fsync(manifest_file.fileno())
        if path.exists():
            raise FileExistsError(f"immutable manifest already exists: {path}")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read codex_image manifest {path}: {error}") from error
    if not isinstance(value, dict) or value.get("schema") != _SCHEMA_VERSION:
        raise RuntimeError(f"Invalid codex_image manifest: {path}")
    image = value.get("image")
    if not isinstance(image, dict) or not isinstance(image.get("file"), str):
        raise RuntimeError(f"Invalid codex_image image manifest: {path}")
    return value


def _public_manifest(manifest: dict[str, Any], manifest_path: Path) -> dict[str, Any]:
    public = dict(manifest)
    image = dict(manifest["image"])
    image_path = (manifest_path.parent / image["file"]).resolve()
    try:
        image_path.relative_to(manifest_path.parent.resolve())
    except ValueError as error:
        raise RuntimeError(f"Manifest image escapes its immutable version: {manifest_path}") from error
    if not image_path.is_file():
        raise RuntimeError(f"Manifest image is missing: {image_path}")
    image["path"] = str(image_path)
    public["image"] = image
    public["path"] = str(image_path)
    workflow_directory = manifest_path.parent.parent.parent.resolve()
    public_references: list[dict[str, Any]] = []
    raw_references = manifest.get("references", [])
    if not isinstance(raw_references, list):
        raise RuntimeError(f"Invalid codex_image references manifest: {manifest_path}")
    for reference in raw_references:
        if not isinstance(reference, dict) or not isinstance(reference.get("file"), str):
            raise RuntimeError(f"Invalid codex_image reference manifest: {manifest_path}")
        reference_path = (workflow_directory / reference["file"]).resolve()
        try:
            reference_path.relative_to(workflow_directory)
        except ValueError as error:
            raise RuntimeError(
                f"Manifest reference escapes its workflow: {manifest_path}"
            ) from error
        if not reference_path.is_file():
            raise RuntimeError(f"Manifest reference is missing: {reference_path}")
        public_references.append({**reference, "path": str(reference_path)})
    public["references"] = public_references
    public["manifest_path"] = str(manifest_path.resolve())
    return public


def list_versions(workflow_id: str | None = None) -> list[dict[str, Any]]:
    """List immutable generated versions in the current Prime Agent session."""
    root = _storage_root(create=False)
    if not root.exists():
        return []
    if workflow_id is None:
        workflow_directories = sorted(
            child
            for child in root.iterdir()
            if child.is_dir() and _WORKFLOW_ID_PATTERN.fullmatch(child.name)
        )
    else:
        workflow_directories = [
            _workflow_directory(_validate_workflow_id(workflow_id), must_exist=True)
        ]

    versions: list[dict[str, Any]] = []
    for workflow_directory in workflow_directories:
        versions_directory = workflow_directory / "versions"
        if not versions_directory.is_dir():
            continue
        for version_directory in sorted(versions_directory.iterdir()):
            if not _VERSION_DIRECTORY_PATTERN.fullmatch(version_directory.name):
                continue
            manifest_path = version_directory / "manifest.json"
            if not manifest_path.is_file():
                continue
            versions.append(
                _public_manifest(_read_manifest(manifest_path), manifest_path)
            )
    versions.sort(key=lambda item: (str(item["workflow_id"]), int(item["version"])))
    return versions


def _load_version(workflow_id: str, version: int) -> dict[str, Any]:
    if isinstance(version, bool) or not isinstance(version, int):
        raise TypeError(f"version must be int, got {type(version).__name__}")
    if version <= 0 or version > _MAX_VERSIONS_PER_WORKFLOW:
        raise ValueError(
            f"version must be between 1 and {_MAX_VERSIONS_PER_WORKFLOW}"
        )
    workflow_directory = _workflow_directory(workflow_id, must_exist=True)
    manifest_path = workflow_directory / "versions" / f"v{version:04d}" / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"codex_image version not found: {workflow_id} v{version:04d}"
        )
    return _public_manifest(_read_manifest(manifest_path), manifest_path)


async def _create_version(
    *,
    workflow_id: str,
    brief: str,
    original_brief: str,
    kind: str,
    references: list[dict[str, Any]],
    label: str | None,
    command: CodexCommand,
    timeout_seconds: float,
    parent: dict[str, Any] | None,
) -> dict[str, Any]:
    workflow_directory = _workflow_directory(workflow_id, must_exist=True)
    version, version_directory = _reserve_version_directory(workflow_directory)
    run_directory = workflow_directory / f".run-{uuid.uuid4().hex}"
    run_directory.mkdir(mode=0o700)
    try:
        command_prefix = _resolve_command(command)
        if parent is None:
            prompt = _initial_prompt(brief, kind, run_directory, len(references))
            reference_arguments = [
                argument
                for reference_path in _reference_paths(
                    workflow_directory, references
                )
                for argument in ("-i", str(reference_path))
            ]
            arguments = [
                *command_prefix,
                "exec",
                "--json",
                "--enable",
                "image_generation",
                *reference_arguments,
                # This option terminates the variadic --image values before the
                # positional stdin marker.
                "--sandbox",
                "workspace-write",
                "--skip-git-repo-check",
                "-C",
                str(workflow_directory),
                "-",
            ]
            expected_thread_id = None
        else:
            previous_path = Path(str(parent["path"])).resolve()
            expected_thread_id = str(parent["thread_id"])
            prompt = _refinement_prompt(
                brief, kind, previous_path, run_directory
            )
            arguments = [
                *command_prefix,
                "exec",
                "resume",
                "--json",
                "--enable",
                "image_generation",
                "--skip-git-repo-check",
                "-i",
                str(previous_path),
                expected_thread_id,
                "-",
            ]

        started_at_ns = time.time_ns()
        events = await _run_codex(
            arguments, prompt, workflow_directory, timeout_seconds
        )
        emitted_thread_id = _extract_thread_id(events)
        if expected_thread_id is None:
            if emitted_thread_id is None:
                raise RuntimeError(
                    "Codex completed without reporting a thread ID; refinement cannot resume safely"
                )
            thread_id = emitted_thread_id
        else:
            if emitted_thread_id is not None and emitted_thread_id != expected_thread_id:
                raise RuntimeError(
                    "Codex resumed a different thread than the requested image workflow"
                )
            thread_id = expected_thread_id

        generated_path = _extract_output_path(
            events, run_directory, workflow_directory, started_at_ns
        )
        mime_type, extension, size, sha256, width, height, has_alpha = _detect_image(
            generated_path
        )
        image_path = version_directory / f"image{extension}"
        _atomic_copy_new(generated_path, image_path)
        (
            copied_mime_type,
            copied_extension,
            copied_size,
            copied_sha256,
            copied_width,
            copied_height,
            copied_has_alpha,
        ) = _detect_image(image_path)
        if (
            copied_mime_type,
            copied_extension,
            copied_size,
            copied_sha256,
            copied_width,
            copied_height,
            copied_has_alpha,
        ) != (mime_type, extension, size, sha256, width, height, has_alpha):
            raise RuntimeError("Codex output changed while it was being captured")
        os.chmod(image_path, 0o444)

        version_label = label or f"Codex {kind} — {workflow_id} v{version:04d}"
        presentation = await host_request(
            "artifact.present", {"path": str(image_path.resolve()), "label": version_label}
        )
        if not isinstance(presentation, dict):
            raise RuntimeError("artifact.present returned an invalid presentation receipt")

        manifest: dict[str, Any] = {
            "schema": _SCHEMA_VERSION,
            "workflow_id": workflow_id,
            "version": version,
            "version_id": f"v{version:04d}",
            "parent_version": None if parent is None else int(parent["version"]),
            "thread_id": thread_id,
            "kind": kind,
            "brief": brief,
            "original_brief": original_brief,
            "references": references,
            "label": version_label,
            "presented": True,
            "presentation": {
                key: presentation[key]
                for key in (
                    "artifactId",
                    "presentationId",
                    "mimeType",
                    "width",
                    "height",
                    "originalWidth",
                    "originalHeight",
                )
                if key in presentation
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
            "image": {
                "file": image_path.name,
                "mime_type": mime_type,
                "bytes": size,
                "sha256": sha256,
                "width": width,
                "height": height,
                "has_alpha": has_alpha,
            },
        }
        manifest_path = version_directory / "manifest.json"
        _write_manifest(manifest_path, manifest)
        os.chmod(manifest_path, 0o444)
        return _public_manifest(manifest, manifest_path)
    except BaseException:
        _remove_tree(version_directory)
        raise
    finally:
        _remove_tree(run_directory)


async def generate(
    brief: str,
    *,
    kind: str = "image",
    references: Sequence[str | os.PathLike[str]] = (),
    label: str | None = None,
    command: CodexCommand = None,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Generate and present the first immutable version of a Codex image workflow."""
    normalized_brief = _validate_brief(brief)
    normalized_kind = _validate_kind(kind)
    normalized_label = _validate_label(label)
    normalized_timeout = _validate_timeout(timeout_seconds)
    root = _storage_root(create=True)
    workflow_id = f"img-{uuid.uuid4().hex}"
    workflow_directory = root / workflow_id
    workflow_directory.mkdir(mode=0o700)
    try:
        captured_references = _copy_references(workflow_directory, references)
        return await _create_version(
            workflow_id=workflow_id,
            brief=normalized_brief,
            original_brief=normalized_brief,
            kind=normalized_kind,
            references=captured_references,
            label=normalized_label,
            command=command,
            timeout_seconds=normalized_timeout,
            parent=None,
        )
    except BaseException:
        _remove_tree(workflow_directory)
        raise


async def refine(
    workflow_id: str,
    brief: str,
    *,
    label: str | None = None,
    command: CodexCommand = None,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Refine the latest version by resuming its exact Codex thread, then present it."""
    validated_id = _validate_workflow_id(workflow_id)
    normalized_brief = _validate_brief(brief)
    normalized_label = _validate_label(label)
    normalized_timeout = _validate_timeout(timeout_seconds)
    versions = list_versions(validated_id)
    if not versions:
        raise RuntimeError(f"codex_image workflow has no completed versions: {validated_id}")
    parent = versions[-1]
    return await _create_version(
        workflow_id=validated_id,
        brief=normalized_brief,
        original_brief=str(parent["original_brief"]),
        kind=str(parent["kind"]),
        references=[
            {
                key: reference[key]
                for key in (
                    "file",
                    "original_name",
                    "mime_type",
                    "bytes",
                    "sha256",
                    "width",
                    "height",
                    "has_alpha",
                )
            }
            for reference in parent.get("references", [])
        ],
        label=normalized_label,
        command=command,
        timeout_seconds=normalized_timeout,
        parent=parent,
    )


def approve(
    workflow_id: str,
    version: int,
    target: str | os.PathLike[str],
    *,
    approved: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Atomically export one immutable version after explicit user approval."""
    if approved is not True:
        raise PermissionError(
            "codex_image.approve requires explicit approved=True after the user approves this version"
        )
    if not isinstance(overwrite, bool):
        raise TypeError(f"overwrite must be bool, got {type(overwrite).__name__}")
    if not isinstance(target, (str, os.PathLike)):
        raise TypeError(
            f"target must be str or path-like, got {type(target).__name__}"
        )
    validated_id = _validate_workflow_id(workflow_id)
    source = _load_version(validated_id, version)
    if source.get("presented") is not True:
        raise PermissionError("codex_image cannot approve a version that was not presented")
    source_path = Path(str(source["path"]))
    source_image = source["image"]
    (
        actual_mime_type,
        _actual_extension,
        actual_size,
        actual_sha256,
        actual_width,
        actual_height,
        actual_has_alpha,
    ) = _detect_image(source_path)
    expected_integrity = (
        source_image.get("mime_type"),
        source_image.get("bytes"),
        source_image.get("sha256"),
        source_image.get("width"),
        source_image.get("height"),
        source_image.get("has_alpha"),
    )
    actual_integrity = (
        actual_mime_type,
        actual_size,
        actual_sha256,
        actual_width,
        actual_height,
        actual_has_alpha,
    )
    if actual_integrity != expected_integrity:
        raise RuntimeError(
            "codex_image version bytes no longer match the presented immutable manifest"
        )

    target_path = Path(target).expanduser().resolve()
    if target_path.exists() and target_path.is_dir():
        raise IsADirectoryError(f"approval target is a directory: {target_path}")
    if target_path.exists() and not overwrite:
        raise FileExistsError(
            f"approval target already exists; pass overwrite=True to replace it: {target_path}"
        )
    if not target_path.parent.is_dir():
        raise FileNotFoundError(
            f"approval target parent does not exist: {target_path.parent}"
        )

    # Persist the user's approval before mutating the external destination. If
    # export later fails, the immutable receipt still records what was approved
    # and no successful repository mutation can exist without that record.
    approval = {
        "schema": _SCHEMA_VERSION,
        "status": "approved_for_export",
        "approved": True,
        "approved_at": datetime.now(timezone.utc).isoformat(),
        "workflow_id": validated_id,
        "version": version,
        "source": str(source_path),
        "target": str(target_path),
        "sha256": actual_sha256,
        "overwrite": overwrite,
    }
    workflow_directory = _workflow_directory(validated_id, must_exist=True)
    approvals_directory = workflow_directory / "approvals"
    approvals_directory.mkdir(mode=0o700, exist_ok=True)
    approval_path = approvals_directory / f"approval-{uuid.uuid4().hex}.json"
    _write_manifest(approval_path, approval)
    os.chmod(approval_path, 0o444)

    temporary = target_path.parent / f".{target_path.name}.codex-image-{uuid.uuid4().hex}.tmp"
    try:
        with source_path.open("rb") as source_file, temporary.open("xb") as target_file:
            shutil.copyfileobj(source_file, target_file, length=1024 * 1024)
            target_file.flush()
            os.fsync(target_file.fileno())
        os.chmod(temporary, 0o644)
        if overwrite:
            os.replace(temporary, target_path)
        elif os.name == "nt":
            # Windows rename is atomic and refuses an existing destination.
            os.rename(temporary, target_path)
        else:
            # Hard-link publication is atomic and refuses to clobber a target
            # that appeared after the preflight check.
            os.link(temporary, target_path)
    finally:
        temporary.unlink(missing_ok=True)

    return {
        **approval,
        "exported": True,
        "approval_path": str(approval_path.resolve()),
    }

"""Persistent harness-state helpers for Prime Agent's RLM kernel.

The state model is intentionally small: it records prompt notes, memory,
skills, subagent specs, and refinement events in the global agent harness
directory by default. Execution still belongs to Prime Agent's TypeScript host
and the existing ``rlm.run`` recursion bridge.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

HarnessKind = Literal["prompt", "memory", "skill", "subagent"]
HarnessScope = Literal["local", "project", "global"]

_DEFAULT_FILE_NAME = "harness_state.json"
_DEFAULT_HARNESS_DIR_NAME = "harness"
_CONFIG_DIR_PARTS = (".prime", "agent")
_KINDS: tuple[HarnessKind, ...] = ("prompt", "memory", "skill", "subagent")
_SCOPES: tuple[HarnessScope, ...] = ("local", "project", "global")
_state_cache: dict[tuple[Path, HarnessScope], "HarnessState"] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(raw: str, fallback: str) -> str:
    normalized = "".join(ch.lower() if ch.isalnum() else "_" for ch in raw.strip())
    normalized = "_".join(part for part in normalized.split("_") if part)
    return (normalized or fallback)[:80]


def _agent_dir() -> Path:
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser().resolve()


def _project_dir() -> Path:
    """Nearest ancestor of the cwd holding a project config dir, else a repo root, else the cwd."""
    cwd = Path.cwd().resolve()
    repo_root: Path | None = None
    for candidate in (cwd, *cwd.parents):
        if candidate.joinpath(*_CONFIG_DIR_PARTS).is_dir():
            return candidate
        if repo_root is None and (candidate / ".git").exists():
            repo_root = candidate
    return repo_root or cwd


def _normalize_scope(scope: HarnessScope | None, extra: dict[str, Any] | None = None) -> HarnessScope | None:
    extra = dict(extra or {})
    if extra:
        unexpected = next(iter(extra))
        raise TypeError(f"unexpected keyword argument {unexpected!r}")
    if scope is None:
        return None
    if scope not in _SCOPES:
        raise ValueError(f"scope must be one of {_SCOPES}, got {scope!r}")
    return scope


def _strip_scope_prefix(id: str | None, scope: HarnessScope | None) -> tuple[str | None, HarnessScope | None]:
    # overview() displays entries as [local:id]/[project:id]/[global:id]; accept
    # those ids verbatim. The prefix routes to that store unless the caller
    # already forced a scope explicitly.
    if isinstance(id, str):
        prefix, sep, rest = id.partition(":")
        if sep and rest and prefix in _SCOPES:
            return rest, scope or prefix  # type: ignore[return-value]
    return id, scope


def _env_dir(name: str) -> str | None:
    # Set-but-empty env values must behave as unset; a bare "" would skip the
    # session-dir fallback and land local writes in the global agent-dir default.
    value = (os.environ.get(name) or "").strip()
    return value or None


def _state_file(state_dir: str | Path | None = None, *, scope: HarnessScope = "local") -> Path:
    root: str | Path | None = state_dir
    if root is None:
        if scope == "global":
            root = _env_dir("RLM_GLOBAL_HARNESS_STATE_DIR")
        elif scope == "project":
            root = _env_dir("RLM_PROJECT_HARNESS_STATE_DIR")
        else:
            root = _env_dir("RLM_HARNESS_STATE_DIR")
    if root is None and scope == "local" and (session_dir := _env_dir("RLM_SESSION_DIR")):
        root = Path(session_dir) / _DEFAULT_HARNESS_DIR_NAME
    if root is None and scope == "local":
        raise RuntimeError(
            "Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. "
            'Use get_harness_state(scope="project") or get_harness_state(scope="global") instead.'
        )
    if root:
        return Path(root).expanduser().resolve() / _DEFAULT_FILE_NAME
    if scope == "project":
        return _project_dir().joinpath(*_CONFIG_DIR_PARTS, _DEFAULT_HARNESS_DIR_NAME, _DEFAULT_FILE_NAME)
    return _agent_dir() / _DEFAULT_HARNESS_DIR_NAME / _DEFAULT_FILE_NAME


@dataclass
class HarnessEntry:
    """A reusable prompt, memory, skill, or subagent record."""

    id: str
    kind: HarnessKind
    title: str
    content: str
    path: str = "general"
    scope: HarnessScope = "local"
    # Disabled entries stay stored but are hidden from the system prompt, so a
    # disabled subagent spec is never offered for delegation.
    enabled: bool = True
    reference: dict[str, Any] = field(default_factory=dict)
    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = "agent"
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    version: int = 1


@dataclass
class RefinementEvent:
    """A recorded online harness-refinement pass."""

    id: str
    trigger: str
    changes: list[str]
    evidence: str = ""
    outcome: str = ""
    created_at: str = field(default_factory=_now)


_ENTRY_FIELDS = {field.name for field in fields(HarnessEntry)}
_REFINEMENT_FIELDS = {field.name for field in fields(RefinementEvent)}


def _validate_python_skill_reference(reference: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(reference, dict):
        raise ValueError("skill entries require a Python reference")
    normalized = dict(reference)
    if normalized.get("type") != "python":
        raise ValueError("skill reference.type must be 'python'")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("import", "python_import")):
        raise ValueError("skill reference requires a Python import")
    if not any(isinstance(normalized.get(key), str) and normalized[key] for key in ("callable", "call_pattern")):
        raise ValueError("skill reference requires a callable or call_pattern")
    return normalized


class HarnessState:
    """CRUD store for reset-free harness refinement state."""

    def __init__(
        self,
        file_path: str | Path | None = None,
        *,
        in_memory: bool = False,
        scope: HarnessScope = "local",
        local_write_error: str | None = None,
    ):
        # in_memory mode never resolves or touches a path. It is the safe fallback when
        # path resolution itself fails, so constructing it cannot re-raise that error.
        if in_memory:
            self.file_path: Path | None = None
        else:
            self.file_path = (
                Path(file_path).expanduser().resolve() if file_path else _state_file(scope=scope)
            )
        self.scope: HarnessScope = scope
        # When set, local mutations raise instead of vanishing into a volatile
        # store; reads and cross-scope delegation keep working.
        self._local_write_error = local_write_error
        self.entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        self.refinements: list[RefinementEvent] = []
        self._delegate_state_dir: Path | None = None
        # mtime of the file as of the last load/save, used to detect out-of-process
        # writes (e.g. the host `/refine` command) and avoid clobbering them.
        self._loaded_mtime: int | None = None
        self.load()

    def _ensure_local_writable(self) -> None:
        if self._local_write_error is not None:
            raise RuntimeError(self._local_write_error)

    def _disk_mtime(self) -> int | None:
        if self.file_path is None:
            return None
        try:
            return self.file_path.stat().st_mtime_ns
        except OSError:
            return None

    def _sync_from_disk(self) -> None:
        """Reload if another process rewrote the state file since we last touched it.

        The kernel keeps a long-lived ``HarnessState`` in memory while the host
        ``/refine`` command rewrites the same file from a separate process. Without
        this guard the next in-kernel ``save()`` would overwrite host edits with a
        stale snapshot. We re-read whenever the on-disk mtime no longer matches the
        value recorded at our last load/save.
        """
        if self._disk_mtime() != self._loaded_mtime:
            self.load()

    def load(self) -> "HarnessState":
        if self.file_path is None or not self.file_path.exists():
            self._loaded_mtime = None
            return self
        mtime = self._disk_mtime()
        try:
            with self.file_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            # A corrupt or unreadable state file must not crash the kernel or block
            # refinement. Treat it as empty; the next save() rewrites it cleanly.
            data = {}
        # json.load returns non-dict types for valid JSON like `null`, `[]`, or a bare
        # string; coerce those to an empty object before attribute access.
        if not isinstance(data, dict):
            data = {}

        entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        raw_entries = data.get("entries", {})
        if isinstance(raw_entries, dict):
            for kind in _KINDS:
                raw_kind_entries = raw_entries.get(kind, {})
                if not isinstance(raw_kind_entries, dict):
                    continue
                for entry_id, raw_entry in raw_kind_entries.items():
                    if isinstance(raw_entry, dict):
                        entry_data = {key: value for key, value in raw_entry.items() if key in _ENTRY_FIELDS}
                        entry_data["id"] = str(entry_id)
                        entry_data["kind"] = kind
                        if not isinstance(entry_data.get("title"), str) or not isinstance(
                            entry_data.get("content"), str
                        ):
                            continue
                        if not isinstance(entry_data.get("path"), str):
                            entry_data["path"] = "general"
                        if entry_data.get("scope") not in _SCOPES:
                            entry_data["scope"] = self.scope
                        entry_data["enabled"] = entry_data.get("enabled") is not False
                        if not isinstance(entry_data.get("source"), str):
                            entry_data["source"] = "agent"
                        version = entry_data.get("version", 1)
                        if isinstance(version, str):
                            try:
                                version = int(version)
                            except ValueError:
                                version = 1
                        if not isinstance(version, int):
                            version = 1
                        entry_data["version"] = version
                        if not isinstance(entry_data.get("reference"), dict):
                            entry_data["reference"] = {}
                        if not isinstance(entry_data.get("arguments"), dict):
                            entry_data["arguments"] = {}
                        if not isinstance(entry_data.get("metadata"), dict):
                            entry_data["metadata"] = {}
                        entries[kind][str(entry_id)] = HarnessEntry(**entry_data)
        self.entries = entries

        self.refinements = []
        raw_refinements = data.get("refinements", [])
        if isinstance(raw_refinements, list):
            for raw_event in raw_refinements:
                if isinstance(raw_event, dict):
                    event_data = {key: value for key, value in raw_event.items() if key in _REFINEMENT_FIELDS}
                    if not isinstance(event_data.get("id"), str) or not isinstance(
                        event_data.get("trigger"), str
                    ):
                        continue
                    changes = event_data.get("changes")
                    if isinstance(changes, str):
                        event_data["changes"] = [changes]
                    elif isinstance(changes, list):
                        event_data["changes"] = [str(change) for change in changes]
                    elif not isinstance(changes, list):
                        continue
                    self.refinements.append(RefinementEvent(**event_data))
        self._loaded_mtime = mtime
        return self

    def _scope_target(self, scope: HarnessScope | None, extra: dict[str, Any] | None = None) -> "HarnessState | None":
        scope = _normalize_scope(scope, extra)
        if scope is None or scope == self.scope:
            return None
        target = get_harness_state(state_dir=self._delegate_state_dir, scope=scope)
        if self.file_path is not None and target.file_path == self.file_path and target.scope == self.scope:
            return None
        return target

    def save(self) -> "HarnessState":
        if self.file_path is None:
            # in_memory fallback: nothing to persist.
            return self
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "schema": 1,
            "entries": {
                kind: {entry_id: asdict(entry) for entry_id, entry in records.items()}
                for kind, records in self.entries.items()
            },
            "refinements": [asdict(event) for event in self.refinements],
        }
        with self.file_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        self._loaded_mtime = self._disk_mtime()
        return self

    def upsert(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.upsert(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        self._sync_from_disk()
        return self._upsert(
            kind,
            title,
            content,
            id=id,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
        )

    def _upsert(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
    ) -> HarnessEntry:
        # Caller is responsible for syncing from disk first. create()/update() sync
        # once and then call this directly so their existence check and the write are
        # not separated by a second reload (which could turn create-or-fail into a
        # silent update).
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")

        entry_id = id or _slug(title, kind)
        existing = self.entries[kind].get(entry_id)
        if existing:
            existing.title = title
            existing.content = content
            # Preserve path/reference/arguments/metadata when the caller omits them
            # (None) so updating only an entry's title or content does not reset its
            # grouping path or wipe a skill's reference/argument contract. An explicit
            # value (including {}) still overwrites.
            if path is not None:
                existing.path = path
            if reference is not None:
                existing.reference = dict(reference)
            if arguments is not None:
                existing.arguments = dict(arguments)
            if metadata is not None:
                existing.metadata = dict(metadata)
            existing.source = source
            existing.updated_at = _now()
            existing.version += 1
            entry = existing
        else:
            entry = HarnessEntry(
                id=entry_id,
                kind=kind,
                title=title,
                content=content,
                path=path if path is not None else "general",
                scope=self.scope,
                reference=dict(reference or {}),
                arguments=dict(arguments or {}),
                metadata=dict(metadata or {}),
                source=source,
            )
            self.entries[kind][entry_id] = entry
        self.save()
        return entry

    def set_enabled(
        self,
        kind: HarnessKind,
        id: str,
        enabled: bool,
        *,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        """Enable or disable one entry without deleting it.

        A disabled entry stays stored and rollback-able but is hidden from the
        system prompt, so a disabled subagent spec is no longer available for
        delegation.
        """
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.set_enabled(kind, id, enabled)
        if not isinstance(enabled, bool):
            raise TypeError(f"enabled must be bool, got {type(enabled).__name__}")
        self._ensure_local_writable()
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        entry = self.entries[kind].get(id)
        if entry is None:
            raise ValueError(f"{kind} entry {id!r} does not exist")
        entry.enabled = enabled
        entry.updated_at = _now()
        self.save()
        return entry

    def disable(self, kind: HarnessKind, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> HarnessEntry:
        return self.set_enabled(kind, id, False, scope=scope, **kwargs)

    def enable(self, kind: HarnessKind, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> HarnessEntry:
        return self.set_enabled(kind, id, True, scope=scope, **kwargs)

    def get(self, kind: HarnessKind, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> HarnessEntry | None:
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.get(kind, id)
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        return self.entries[kind].get(id)

    def delete(self, kind: HarnessKind, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> bool:
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.delete(kind, id)
        self._ensure_local_writable()
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if id not in self.entries[kind]:
            return False
        del self.entries[kind][id]
        self.save()
        return True

    def list(self, kind: HarnessKind | None = None, *, scope: HarnessScope | None = None, **kwargs: Any) -> list[HarnessEntry]:
        if target := self._scope_target(scope, kwargs):
            return target.list(kind)
        self._sync_from_disk()
        kinds = [kind] if kind else list(_KINDS)
        records: list[HarnessEntry] = []
        for current_kind in kinds:
            if current_kind not in self.entries:
                raise ValueError(f"unknown harness kind {current_kind!r}; expected one of {_KINDS}")
            records.extend(self.entries[current_kind].values())
        return sorted(records, key=lambda entry: (entry.kind, entry.path, entry.title, entry.id))

    def create(
        self,
        kind: HarnessKind,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.create(
                kind,
                title,
                content,
                id=id,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        entry_id = id or _slug(title, kind)
        if entry_id in self.entries[kind]:
            raise ValueError(f"{kind} entry {entry_id!r} already exists")
        return self._upsert(
            kind,
            title,
            content,
            id=entry_id,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
        )

    def update(
        self,
        kind: HarnessKind,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        source: str = "agent",
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        id, scope = _strip_scope_prefix(id, scope)
        if target := self._scope_target(scope, kwargs):
            return target.update(
                kind,
                id,
                title,
                content,
                path=path,
                reference=reference,
                arguments=arguments,
                metadata=metadata,
                source=source,
            )
        self._ensure_local_writable()
        self._sync_from_disk()
        if kind not in self.entries:
            raise ValueError(f"unknown harness kind {kind!r}; expected one of {_KINDS}")
        if id not in self.entries[kind]:
            raise ValueError(f"{kind} entry {id!r} does not exist")
        return self._upsert(
            kind,
            title,
            content,
            id=id,
            path=path,
            reference=reference,
            arguments=arguments,
            metadata=metadata,
            source=source,
        )

    def create_memory(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("memory", title, content, id=id, path=path, metadata=metadata, scope=scope, **kwargs)

    def update_memory(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("memory", id, title, content, path=path, metadata=metadata, scope=scope, **kwargs)

    def delete_memory(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> bool:
        return self.delete("memory", id, scope=scope, **kwargs)

    def create_prompt_note(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "policy",
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("prompt", title, content, id=id, path=path, metadata=metadata, scope=scope, **kwargs)

    def update_prompt_note(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("prompt", id, title, content, path=path, metadata=metadata, scope=scope, **kwargs)

    def delete_prompt_note(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> bool:
        return self.delete("prompt", id, scope=scope, **kwargs)

    def create_skill(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create(
            "skill",
            title,
            content,
            id=id,
            path=path,
            reference=_validate_python_skill_reference(reference),
            arguments=arguments,
            metadata=metadata,
            scope=scope,
            **kwargs,
        )

    def update_skill(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        reference: dict[str, Any] | None = None,
        arguments: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        # Only validate a reference when one is supplied; omitting it preserves the
        # existing reference (see _upsert) rather than forcing every title/content-only
        # update to re-send the full Python reference.
        validated_reference = _validate_python_skill_reference(reference) if reference is not None else None
        return self.update(
            "skill",
            id,
            title,
            content,
            path=path,
            reference=validated_reference,
            arguments=arguments,
            metadata=metadata,
            scope=scope,
            **kwargs,
        )

    def delete_skill(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> bool:
        return self.delete("skill", id, scope=scope, **kwargs)

    def create_subagent(
        self,
        title: str,
        content: str,
        *,
        id: str | None = None,
        path: str = "general",
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.create("subagent", title, content, id=id, path=path, metadata=metadata, scope=scope, **kwargs)

    def update_subagent(
        self,
        id: str,
        title: str,
        content: str,
        *,
        path: str | None = None,
        metadata: dict[str, Any] | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> HarnessEntry:
        return self.update("subagent", id, title, content, path=path, metadata=metadata, scope=scope, **kwargs)

    def delete_subagent(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> bool:
        return self.delete("subagent", id, scope=scope, **kwargs)

    def disable_subagent(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> HarnessEntry:
        """Keep a subagent spec but stop offering it for delegation."""
        return self.set_enabled("subagent", id, False, scope=scope, **kwargs)

    def enable_subagent(self, id: str, *, scope: HarnessScope | None = None, **kwargs: Any) -> HarnessEntry:
        return self.set_enabled("subagent", id, True, scope=scope, **kwargs)

    def record_refinement(
        self,
        trigger: str,
        changes: list[str] | str,
        *,
        evidence: str = "",
        outcome: str = "",
        id: str | None = None,
        scope: HarnessScope | None = None,
        **kwargs: Any,
    ) -> RefinementEvent:
        if target := self._scope_target(scope, kwargs):
            return target.record_refinement(trigger, changes, evidence=evidence, outcome=outcome, id=id)
        self._ensure_local_writable()
        self._sync_from_disk()
        event_id = id or f"refine_{len(self.refinements) + 1:04d}"
        normalized_changes = [changes] if isinstance(changes, str) else list(changes)
        event = RefinementEvent(
            id=event_id,
            trigger=trigger,
            changes=normalized_changes,
            evidence=evidence,
            outcome=outcome,
        )
        self.refinements.append(event)
        self.save()
        return event

    def plan_refinement(
        self,
        observation: str,
        *,
        failing_component: str = "",
        next_step: str = "",
    ) -> list[str]:
        target = f" for {failing_component}" if failing_component else ""
        plan = [
            f"Diagnose the repeated failure or opportunity{target}: {observation}",
            "Update the smallest useful prompt note, memory item, skill, or subagent spec.",
            "Run the next action with the changed harness state, then record the outcome.",
        ]
        if next_step:
            plan.append(f"Immediate validation step: {next_step}")
        return plan

    def overview(self, *, max_entries_per_kind: int = 20, scope: HarnessScope | None = None, **kwargs: Any) -> str:
        if target := self._scope_target(scope, kwargs):
            return target.overview(max_entries_per_kind=max_entries_per_kind)
        self._sync_from_disk()
        lines = [
            f"Harness state ({self.scope}): {self.file_path}",
            "Call contract: installed Python skills use await <skill_import>(...) or a matching shell CLI; "
            "harness skill entries are Python REPL skills and must include a Python reference plus arguments. "
            "Spawn a subagent spec by composing a concise task prompt and calling "
            "handle = await rlm('sub-task'); admission returns immediately with rlm_child_id, name, session_dir, "
            "and model, never the child's answer. Results arrive only through explicit agent_message replies or "
            "files; children reply with await agent_message.send(message, receiver_role='parent'). Use "
            "await rlm.list_subagents() to recover direct child handles and await agent_message.send(..., "
            "receiver_role='child', receiver_name=handle.name) for follow-ups.",
        ]
        for kind in _KINDS:
            records = self.list(kind)[:max_entries_per_kind]
            lines.append(f"{kind}: {len(self.entries[kind])}")
            for entry in records:
                summary = entry.content.strip().replace("\n", " ")
                if len(summary) > 120:
                    summary = f"{summary[:117]}..."
                argument_summary = ""
                if entry.kind == "skill" and entry.arguments:
                    argument_text = json.dumps(entry.arguments, ensure_ascii=False, sort_keys=True)
                    if len(argument_text) > 120:
                        argument_text = f"{argument_text[:117]}..."
                    argument_summary = f" args={argument_text}"
                reference_summary = ""
                if entry.kind == "skill" and entry.reference:
                    reference_text = json.dumps(entry.reference, ensure_ascii=False, sort_keys=True)
                    if len(reference_text) > 120:
                        reference_text = f"{reference_text[:117]}..."
                    reference_summary = f" ref={reference_text}"
                disabled_marker = "" if entry.enabled else " [disabled]"
                lines.append(
                    f"  - [{entry.scope}:{entry.id}]{disabled_marker} {entry.title} ({entry.path}, v{entry.version})"
                    f"{reference_summary}{argument_summary}: {summary}"
                )
            overflow = len(self.entries[kind]) - len(records)
            if overflow > 0:
                lines.append(f"  - +{overflow} more")
        if self.refinements:
            lines.append(f"refinements: {len(self.refinements)}")
            for event in self.refinements[-5:]:
                lines.append(f"  - [{event.id}] {event.trigger}: {', '.join(event.changes)}")
        else:
            lines.append("refinements: 0")
        return "\n".join(lines)

    def snapshot(self, *, scope: HarnessScope | None = None, **kwargs: Any) -> dict[str, Any]:
        if target := self._scope_target(scope, kwargs):
            return target.snapshot()
        self._sync_from_disk()
        return {
            "file_path": str(self.file_path),
            "scope": self.scope,
            "entries": {
                kind: {entry_id: asdict(entry) for entry_id, entry in records.items()}
                for kind, records in self.entries.items()
            },
            "refinements": [asdict(event) for event in self.refinements],
        }


def get_harness_state(
    state_dir: str | Path | None = None, *, scope: HarnessScope | None = None, **kwargs: Any
) -> HarnessState:
    """Return the cached harness state for a scope (local by default)."""
    resolved_scope: HarnessScope = _normalize_scope(scope, kwargs) or "local"
    file_path = _state_file(state_dir, scope=resolved_scope)
    cache_key = (file_path, resolved_scope)
    state = _state_cache.get(cache_key)
    if state is None:
        state = HarnessState(file_path, scope=resolved_scope)
        # Recorded at construction only: an instance created from env defaults must
        # keep targeting the env-resolved stores even when a later explicit
        # state_dir call aliases the same local file. An explicit dir that merely
        # aliases the env resolution must not sandbox later cross-scope writes
        # either, so pin only when the explicit dir actually diverges.
        if state_dir is not None:
            try:
                env_file: Path | None = _state_file(scope=resolved_scope)
            except RuntimeError:
                env_file = None
            if file_path != env_file:
                state._delegate_state_dir = Path(state_dir).expanduser().resolve()
        _state_cache[cache_key] = state
    return state


__all__ = [
    "HarnessEntry",
    "HarnessKind",
    "HarnessScope",
    "HarnessState",
    "RefinementEvent",
    "get_harness_state",
]

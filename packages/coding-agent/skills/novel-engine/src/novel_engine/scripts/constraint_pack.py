"""Project constraint pack loader (cross-project swap point).

The constraint pack is `config/constraints/project_constraints.yaml`:
A-route regex patterns, foreshadow anchor phrases, the compliance note,
and the mid-outline `characters` replacement table. Swapping the pack
re-targets the content constraints without touching the engine or the
process scripts.

The audit script keeps its own canonical `_A_ROUTE_PATTERNS` copy; this
loader is the reference implementation for `outline_repair` and any new
consumer. If the pack is missing or a section is empty, consumers fall
back to their built-in defaults (the values of the current project).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "config" / "constraints" / "project_constraints.yaml"


def _read_pack(pack_path: Path | None = None) -> dict:
    """Parse the pack. No PyYAML dependency: restricted subset --
    `key:` opens a list, `- "K: V"` items become dict entries,
    `- "A = B"` items stay pairs, `key: value` scalars direct.
    pack_path 可覆盖默认 PACK（测试/多项目场景）。"""
    _p = pack_path or PACK
    if not _p.exists():
        return {}
    data: dict = {}
    current: str | None = None
    for raw in _p.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if re.match(r"^\s+- ", line):
            if current:
                item = line.lstrip()[2:].strip().strip("\"'")
                if current not in data:
                    data[current] = []
                data[current].append(item)
            continue
        m = re.match(r"^([A-Za-z_0-9]+):(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        current = key if (val in ("", "[", "{")) else None
        if val not in ("", "[", "{"):
            data[key] = val.strip("\"'")
        elif key not in data:
            data[key] = [] if val in ("", "[") else {}
    return data


def _pairs(items: list[str]) -> list[tuple[str, str]]:
    out = []
    for item in items:
        m = re.match(r"^(.+?) = (.+)$", item)
        out.append((m.group(1).strip(), m.group(2).strip()) if m
                   else (item, ""))
    return out


def _kv(items: list[str]) -> dict[str, str]:
    out = {}
    for item in items:
        m = re.match(r"^(.+?): (.+)$", item)
        if m:
            out[m.group(1).strip().lower()] = m.group(2).strip()
    return out


class ConstraintPack:
    """Typed view over the pack; missing sections raise with guidance."""

    def __init__(self, data: dict | None = None) -> None:
        self._data = data if data is not None else _read_pack()

    @property
    def loaded(self) -> bool:
        return bool(self._data)

    def a_route_patterns(self) -> list[tuple[str, str]]:
        """(regex, reason) pairs; same shape as audit `_A_ROUTE_PATTERNS`."""
        items = self._data.get("a_route_patterns", [])
        return _pairs(items) if isinstance(items, list) else []

    def anchor_phrases(self) -> dict[str, str]:
        items = self._data.get("anchor_phrases", [])
        return _kv(items) if isinstance(items, list) else {}

    def compliance_note(self) -> str:
        v = self._data.get("compliance_note", "")
        return v if isinstance(v, str) else ""

    def character_replacements(self) -> dict[str, str]:
        items = self._data.get("character_replacements", [])
        return _kv(items) if isinstance(items, list) else {}

    def review_hard_constraints(self) -> list[str]:
        """reviewer_agent 的换书硬约束行（project_constraints.yaml 的
        review_hard_constraints 段）；缺省返回 []（调用方回退内置默认）。"""
        items = self._data.get("review_hard_constraints", [])
        return [s for s in items if isinstance(s, str) and s.strip()] if isinstance(items, list) else []


def load_pack(project_root: Path | str | None = None) -> ConstraintPack:
    """读约束包。project_root 给出时定位 <root>/config/constraints/project_constraints.yaml，
    否则用默认 PACK（当前包根）。换书迁移时传新项目的 root。"""
    if project_root is not None:
        _p = Path(project_root) / "config" / "constraints" / "project_constraints.yaml"
        return ConstraintPack(_read_pack(_p))
    return ConstraintPack()


def dump(pack: ConstraintPack) -> str:
    """Serialize back to JSON (used by tests/tooling)."""
    return json.dumps({
        "a_route_patterns": [
            {"pattern": p, "reason": r}
            for p, r in pack.a_route_patterns()
        ],
        "anchor_phrases": pack.anchor_phrases(),
        "compliance_note": pack.compliance_note(),
        "character_replacements": pack.character_replacements(),
    }, ensure_ascii=False, indent=2)

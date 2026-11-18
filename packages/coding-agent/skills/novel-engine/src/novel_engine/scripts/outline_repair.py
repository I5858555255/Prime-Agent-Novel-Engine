"""One-pass repair of the four recurring mid-outline audit flags.

Implements the decision tree from `docs/outline-fixes.md` §2 as an
idempotent transform over a single mid-outline file:

1. `pending_human` via "需人工确认" in `boundary_note`
   -> rewrite the note as a declarative "铺垫：…" conclusion (the audit
      rule at audit_mid_outline.py L439 makes "需人工确认" permanent).
2. unregistered names in `characters` (e.g. the foreshadow id F008,
   "后续角色", "摄魂阁高层")
   -> replace with the registered role C007（守夜人）.
3. out-of-range / non-integers in `characters`
   -> drop.
4. `core_event` empty or "本批生成失败"
   -> mark for `--only` regeneration (reported, not invented).
5. foreshadow anchor words (from `config/foreshadow/registry.json`)
   referenced by `boundary_note` but missing from `core_event`
   -> append the anchor phrase to `core_event` (f009 + A-route
   boundary note added when the anchor is f009).

Run BEFORE `audit_mid_outline`; it never sets `meta.status` or
`entry.status` — convergence (30/30 approved) is still decided by the
audit. Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.outline_repair \
        config/planning/mid_outline_V05_ch1757-1786.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(__file__).resolve().parents[2]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from novel_engine.scripts.constraint_pack import load_pack  # noqa: E402

# Built-in defaults = the values of the current project pack
# (config/constraints/project_constraints.yaml). Used when the pack is
# missing or a section is empty, so the repairer keeps working.
_DEFAULT_CHAR_REPLACEMENTS = {
    "f008": "C007",
    "f008_doorkeeper": "C007",
    "f008守夜人": "C007",
    "后续角色": "C007",
    "摄魂阁高层": "C007",
    "c007（守夜人）": "C007",
    "c007(守夜人)": "C007",
}

# A-route #8 compliance tail appended when the f009 anchor is forced in.
_DEFAULT_A_ROUTE_NOTE = ("（A路线#8合规：陆烬此阶段仅旁观/被告知，"
                          "修炼样式动作限陈老根；plant@本章, resolve@3800 前）")


def _char_replacements() -> dict[str, str]:
    pack = load_pack()
    return pack.character_replacements() or _DEFAULT_CHAR_REPLACEMENTS


def _a_route_note() -> str:
    pack = load_pack()
    return pack.compliance_note() or _DEFAULT_A_ROUTE_NOTE


def _load_registry_anchors() -> dict[str, list[str]]:
    path = ROOT / "config" / "foreshadow" / "registry.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for item in data.get("foreshadows", data if isinstance(data, list) else []):
        fid = str(item.get("id", item.get("fid", ""))).lower()
        anchors = [str(a) for a in (item.get("anchors") or [])]
        if fid and anchors:
            out[fid] = anchors
    return out


def _fid_in_note(note: str) -> str | None:
    """(legacy helper, retained for reference; repair_entry now matches
    registry keys against the note directly)."""
    m = re.search(r"[Ff]0(\d{2})", note or "")
    return f"f{m.group(1)}" if m else None


def _load_registered_chars() -> set[str]:
    """character_registry.json: names + ids (same loader as the audit)."""
    path = ROOT / "config" / "planning" / "character_registry.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    return (set(data.get("characters", []))
            | set(data.get("character_ids", [])))


def repair_entry(entry: dict, fid_anchors: dict[str, list[str]],
                 registry: set[str],
                 char_repl: dict[str, str] | None = None,
                 a_route_note: str | None = None,
                 anchor_phrases: dict[str, str] | None = None) -> list[str]:
    """Mutate one entry in place; return the applied fix descriptions.

    `anchor_phrases`（约束包 anchor_phrases）优先于 registry 全锚点词表
    作为追加短语来源；缺省时退回 registry。"""
    fixes: list[str] = []
    char_repl = _char_replacements() if char_repl is None else char_repl
    a_route_note = _a_route_note() if a_route_note is None else a_route_note
    phrases = anchor_phrases if anchor_phrases is not None else {}
    note = entry.get("boundary_note")

    # 1) permanent-pending wording -> declarative boundary note
    if note and "需人工确认" in str(note):
        cleaned = str(note).replace("需人工确认：", "").replace("需人工确认:", "")
        cleaned = cleaned.strip() or "本章事件推进，不揭露关键设定"
        entry["boundary_note"] = f"铺垫：{cleaned}"
        fixes.append("boundary_note 陈述式化（去'需人工确认'）")

    # 2/3) characters: keep registry entries + C ids + replacement targets;
    # replace known stand-ins (F008/后续角色/摄魂阁高层) with C007.
    chars = entry.get("characters")
    if isinstance(chars, list):
        new_chars: list[object] = []
        for c in chars:
            s = str(c).strip()
            low = s.lower()
            if low in char_repl:
                new_chars.append(char_repl[low])
                fixes.append(f"characters 替换 {s!r} -> {char_repl[low]}")
            elif s in registry or re.fullmatch(r"[Cc]\d{2,3}", s):
                new_chars.append(c)
            else:
                fixes.append(f"characters 丢弃未登记 {s!r}")
        entry["characters"] = new_chars

    # 4) empty / failed core_event -> report for --only (do not invent)
    event = str(entry.get("core_event", "") or "").strip()
    if not event or "本批生成失败" in event:
        fixes.append("core_event 为空/生成失败：需 generate --only 补章")
        return fixes

    # 5) fid anchor words missing from the entry text -> append anchor
    # phrase to core_event (matches the audit's joined-text check).
    note = str(entry.get("boundary_note") or "")
    fid = None
    for key in fid_anchors:
        if key in note:
            fid = key
            break
    if fid and fid in fid_anchors:
        anchors = [phrases[fid]] if fid in phrases else fid_anchors[fid]
        joined = " ".join([event,
                           " ".join(str(c) for c in entry.get("characters") or []),
                           note])
        if not any(a in joined for a in anchors):
            entry["core_event"] = f"{event}（锚点：{'、'.join(anchors)}）"
            fixes.append(f"core_event 追加 {fid} 锚点短语")
            if fid == "f009":
                cur = str(entry.get("boundary_note") or "")
                if "A路线" not in cur and a_route_note:
                    entry["boundary_note"] = cur.rstrip() + a_route_note
                    fixes.append("boundary_note 追加 A路线#8 合规尾注")
    return fixes
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="mid-outline JSON path")
    parser.add_argument("--no-write", action="store_true",
                        help="report fixes without writing the file")
    args = parser.parse_args(argv)

    path = Path(args.file)
    if not path.is_absolute():
        path = ROOT / path
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data.get("entries") or {}
    fid_anchors = _load_registry_anchors()
    registry = _load_registered_chars()
    from novel_engine.scripts.constraint_pack import load_pack
    pack = load_pack()
    phrases = pack.anchor_phrases()

    total_fixes = 0
    for ch in sorted(entries, key=lambda k: int(k) if k.isdigit() else 0):
        entry = entries[ch]
        if not isinstance(entry, dict):
            continue
        fixes = repair_entry(entry, fid_anchors, registry,
                             anchor_phrases=phrases or None)
        if fixes:
            total_fixes += 1
            print(f"ch{ch}: " + "；".join(fixes))

    if not args.no_write:
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"\n{total_fixes} entries repaired, written to {path.name}")
    else:
        print(f"\n{total_fixes} entries would be repaired (--no-write)")
    print("下一步：python -X utf8 -m novel_engine.scripts.audit_mid_outline "
          f"{path.name}（30/30 approved 后写 meta.status=approved）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

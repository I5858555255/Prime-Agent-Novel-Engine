"""audit_mid_outline: 中纲草稿前置校验（生成后、交付 Director 前，必须执行）。

对 config/planning/mid_outline_*.json 的每条章级意图做自动判定：
  1) 判定规则库（config/planning/decision_rules.json，bible/decision_rules.md 的
     条款化实现）逐条匹配——forbidden 类 → needs_regenerate；allowed/hint 类 → approved；
     R11 密度类 → 批次级密度统计后收紧；
  2) 未命中规则 → concept_unlocks 判定（scope_gate）；
  3) A 路线硬红线 + author_intent 当前卷 forbidden；
  4) boundary_note 自带"需人工确认"→ pending_human。

判定结果写回每条 entry.status（approved / pending_human / needs_regenerate），
供 chapter_director 逐条门禁读取（meta.status=draft 时逐条 approved 才可用，
实现"挂起单章不阻塞批次"）。

Usage (run from src/):
    python -m novel_engine.scripts.audit_mid_outline <path_to_mid_outline.json> [--no-write]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

_SRC_ROOT = str(Path(__file__).resolve().parents[2])
if _SRC_ROOT not in sys.path:
    sys.path.insert(0, _SRC_ROOT)

ROOT = Path(__file__).resolve().parents[1]

_DENSITY_WINDOW = 30  # R11 密度窗口：同一伏笔 30 章内暗示上限
_DENSITY_MAX = 3

# A 路线硬红线模式（第一阶段 ch1-316：陆烬禁修炼样式动作；
# 呼吸法仅陈老根练/提及，陆烬最多旁观或被告知结果）。
# 主语判定用"紧邻"而非宽间隔，避免把"陆烬旁观陈老根练习"误判为陆烬修炼。
_A_ROUTE_PATTERNS = [
    (r"陆烬(亲自|独自|也跟着|也|在山林间|在屋里|晚间|夜晚|白天|偷偷|默默)?(练习|修炼|运转|引气|吐纳|打坐|调息|催动)",
     "陆烬亲自出现修炼样式动作"),
    (r"陆烬.{0,4}(照着|学着|模仿|跟着).{0,10}(练|练习|呼吸法|吐纳)",
     "陆烬模仿修炼样式动作"),
    (r"陆烬体内.{0,20}(运转|流转|共鸣|气感|气流|暖意)", "陆烬体内出现气机运转/共鸣"),
    (r"(练|修炼|运转|引气|吐纳|打坐|调息)的.{0,8}(是|主角|他)", "动作主语指回陆烬"),
]

_STATUS_ORDER = {"needs_regenerate": 0, "pending_human": 1, "approved": 2}


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[error] failed to parse {path}: {exc}")
        return {}


def _load_decision_rules() -> list[dict]:
    p = ROOT / "config" / "planning" / "decision_rules.json"
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("rules", [])
    except Exception:
        return []


def decide_entry(
    event: str, chars: list, note: str, chapter: int,
    rules: list[dict], joined: str | None = None,
) -> tuple[str, str, str | None]:
    """对单条章级意图做规则判定。

    返回 (status, reason, rule_id|None)。
    status: approved / pending_human / needs_regenerate。
    注意：R11 密度类在此不判定（返回特殊标记），由批次级统计处理。
    """
    if joined is None:
        joined = f"{event} {', '.join(str(c) for c in chars)}"
    for r in rules:
        for pat in r.get("patterns", []):
            try:
                m = re.search(pat, joined)
            except re.error:
                continue
            if not m:
                continue
            scale = r.get("scale", "forbidden")
            rid = r.get("id", "")
            if scale == "forbidden":
                return "needs_regenerate", f"规则{rid}: {r.get('name', '')}", rid
            if r.get("action") == "density_count":
                return "__density__", f"规则{rid}: {r.get('name', '')}", rid
            # allowed / hint → approved（hint 类附规则 note 供后续追踪）
            return "approved", f"规则{rid}: {r.get('name', '')}", rid
    return "", "", None


def _current_volume_forbidden(author_intent: str, vid: str, chapter_num: int) -> list[str]:
    if not author_intent:
        return []
    for blk in re.split(r"^## ", author_intent, flags=re.M):
        m = re.match(r"第[一二三四五六七八九十]+阶段[：:].*?（.*?第?(\d+)-(\d+)章?）", blk)
        if not m:
            continue
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo <= chapter_num <= hi:
            return [ln.strip().lstrip("- ").strip('"')
                    for ln in blk.splitlines() if ln.strip().startswith("-")]
    return []


def _atomic_write_json(path: Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp", prefix=".audit_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, str(path))
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit mid-level outline draft.")
    parser.add_argument("path", help="Path to mid_outline JSON (or 'auto' to scan config/planning/)")
    parser.add_argument("--no-write", action="store_true", help="只报告不写回 entry.status")
    args = parser.parse_args(argv)

    if args.path.lower() == "auto":
        candidates = sorted((ROOT / "config" / "planning").glob("mid_outline_*.json"))
        if not candidates:
            print("[error] no mid_outline_*.json found under config/planning/")
            return 2
        path = candidates[0]
    else:
        path = Path(args.path)
    data = _load_json(path)
    if not data:
        return 2

    entries = data.get("entries", {})
    meta = data.get("meta", {})
    if meta.get("status") != "draft":
        print(f"[info] meta.status={meta.get('status')} (expected 'draft' for audit)")

    rules = _load_decision_rules()
    if not rules:
        print("[warn] decision_rules.json 未加载，规则表判定跳过（仅 concept/forbidden/A 路线）")

    # 全局初始化（scope_gate 内部缓存）
    from novel_engine.quality.scope_gate import (
        detect_scope_violations,
        reset_concept_cache,
    )
    reset_concept_cache()

    author_intent = ""
    p = ROOT / "bible" / "author_intent.md"
    if p.exists():
        author_intent = p.read_text(encoding="utf-8")

    passed: list[int] = []
    human_confirm: list[tuple[int, str]] = []
    hard_blocked: list[tuple[int, str]] = []
    empty: list[int] = []
    density_chapters: list[int] = []
    status_map: dict[int, str] = {}

    for ch_str, entry in sorted(entries.items()):
        chapter = int(ch_str)
        event = str(entry.get("core_event", "") or "").strip()
        chars = entry.get("characters") or []
        note = entry.get("boundary_note") or ""
        joined = f"{event} {', '.join(str(c) for c in chars)}"

        # 1) 空条目（生成失败的占位）
        if not event or event == "需人工确认" or "本批生成失败" in event:
            empty.append(chapter)
            status_map[chapter] = "needs_regenerate"
            human_confirm.append((chapter, "中纲条目为空/本批生成失败，需重跑"))
            continue

        # 2) 判定规则库（bible 条款化，最高优先）
        status, why, rid = decide_entry(event, chars, note, chapter, rules, joined)
        if status == "__density__":
            density_chapters.append(chapter)
            status_map[chapter] = "approved"
            passed.append(chapter)
            continue
        if status:
            status_map[chapter] = status
            if status == "approved":
                passed.append(chapter)
            else:
                hard_blocked.append((chapter, why))
            continue

        # 3) A 路线硬红线
        a_route_hit = None
        for pat, why in _A_ROUTE_PATTERNS:
            if re.search(pat, joined):
                a_route_hit = why
                break
        if a_route_hit:
            status_map[chapter] = "needs_regenerate"
            hard_blocked.append((chapter, f"撞 A 路线硬红线: {a_route_hit}"))
            continue

        # 4) 自带 boundary_note 标注
        if "需人工确认" in str(note):
            status_map[chapter] = "pending_human"
            human_confirm.append((chapter, str(note)))
            continue

        # 5) concept_unlocks 判定
        result = detect_scope_violations(joined, chapter, {}, ROOT)
        if result["hard"]:
            terms = "; ".join(f"{h['term']}({h['sentence'][:30]})" for h in result["hard"][:5])
            status_map[chapter] = "needs_regenerate"
            hard_blocked.append((chapter, f"撞 concept 硬锁: {terms}"))
            continue
        if result["soft"]:
            terms = "; ".join(f"{h['term']}({h['sentence'][:30]})" for h in result["soft"][:5])
            status_map[chapter] = "pending_human"
            human_confirm.append((chapter, f"soft 命中: {terms}"))
            continue

        # 6) forbidden 条款命中（子串匹配）
        forbidden = _current_volume_forbidden(author_intent, meta.get("vid", ""), chapter)
        hits = [f for f in forbidden if f and f in joined]
        if hits:
            status_map[chapter] = "needs_regenerate"
            hard_blocked.append((chapter, f"撞 author_intent forbidden: {hits[:3]}"))
            continue

        # 7) 默认通过
        status_map[chapter] = "approved"
        passed.append(chapter)

    # R11 密度批次级统计：同一伏笔 30 章窗口内暗示 >3 次 → 收紧为 pending_human
    density_flagged: list[int] = []
    if density_chapters:
        for ch in sorted(density_chapters):
            window = [c for c in density_chapters if ch - _DENSITY_WINDOW < c <= ch]
            if len(window) > _DENSITY_MAX:
                density_flagged.append(ch)
                status_map[ch] = "pending_human"
        if density_flagged:
            # 从 passed 移除
            passed = [c for c in passed if c not in set(density_flagged)]
            human_confirm.append(
                (density_flagged[0], f"迷雾/禁区氛围密度超限（30 章内暗示 >{_DENSITY_MAX} 次）: {sorted(density_flagged)}")
            )

    # 写回 entry.status（原子写）
    if not args.no_write:
        for ch_str, entry in entries.items():
            st = status_map.get(int(ch_str))
            if st is not None:
                entry["status"] = st
        if "audit" not in meta:
            meta["audit"] = {}
        meta["audit"]["last_run"] = True
        _atomic_write_json(path, data)
        print(f"[write] 已写回 entry.status 到 {path.name}")

    print(f"=== 中纲草稿校验报告: {path.name} ===")
    print(f"条目总数: {len(entries)}")
    print(f"a) 校验通过(approved): {len(passed)} 章 {sorted(passed)}")
    print(f"b) 需人工确认(pending_human): {len(human_confirm)} 章")
    for ch, why in human_confirm:
        print(f"   - ch{ch}: {why}")
    print(f"c) 直接撞锁/撞forbidden(needs_regenerate): {len(hard_blocked)} 章")
    for ch, why in hard_blocked:
        print(f"   - ch{ch}: {why}")
    if empty:
        print(f"[注意] 其中 {len(empty)} 章为空条目: {sorted(empty)}")
    if density_flagged:
        print(f"[密度] 迷雾氛围密度收紧: {sorted(density_flagged)}")

    # 退出码：有 needs_regenerate → 1（需重生成）；空条目 → 2；否则 0
    if hard_blocked:
        return 1
    if empty:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

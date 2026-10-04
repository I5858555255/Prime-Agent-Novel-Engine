"""audit_mid_outline: 中纲草稿前置校验（生成后、交付 Director 前，必须执行）。

对 config/planning/mid_outline_*.json 的每条章级意图做 concept_unlocks 判定
（复用 scope_gate.detect_scope_violations）与 forbidden 条款命中检查，
输出三类汇总报告（不逐条罗列全部细节）：
  a) 校验通过的章节数；
  b) 标记"需人工确认"的具体章节 + 原因（涉及呼吸法/修炼边界、新增角色、
     中纲条目 boundary_note 自带标注、接近伏笔回收边界等）；
  c) 直接撞锁/撞 forbidden 的章节，退回重新生成（不自动放行）。

Usage (run from src/):
    python -m novel_engine.scripts.audit_mid_outline <path_to_mid_outline.json>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_SRC_ROOT = str(Path(__file__).resolve().parents[2])
if _SRC_ROOT not in sys.path:
    sys.path.insert(0, _SRC_ROOT)

ROOT = Path(__file__).resolve().parents[1]

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


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[error] failed to parse {path}: {exc}")
        return {}


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit mid-level outline draft.")
    parser.add_argument("path", help="Path to mid_outline JSON (or 'auto' to scan config/planning/)")
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

    for ch_str, entry in sorted(entries.items()):
        chapter = int(ch_str)
        event = str(entry.get("core_event", "") or "").strip()
        chars = entry.get("characters") or []
        note = entry.get("boundary_note") or ""
        joined = f"{event} {', '.join(str(c) for c in chars)}"

        # 1) 空条目（生成失败的占位）
        if not event or event == "需人工确认" or "本批生成失败" in event:
            empty.append(chapter)
            human_confirm.append((chapter, "中纲条目为空/本批生成失败，需重跑"))
            continue

        # 2) A 路线硬红线：第一阶段（1-316 章）陆烬不得亲自修炼样式动作。
        #    纯词表判不出（词表只有"吐纳/引气"等硬词），须按主语模式判定。
        a_route_hit = None
        for pat, why in _A_ROUTE_PATTERNS:
            if re.search(pat, joined):
                a_route_hit = why
                break
        if a_route_hit:
            hard_blocked.append((chapter, f"撞 A 路线硬红线: {a_route_hit}"))
            continue

        # 3) 自带 boundary_note 标注
        if "需人工确认" in str(note):
            human_confirm.append((chapter, str(note)))
            continue

        # 3) concept_unlocks 判定
        result = detect_scope_violations(joined, chapter, {}, ROOT)
        if result["hard"]:
            terms = "; ".join(f"{h['term']}({h['sentence'][:30]})" for h in result["hard"][:5])
            hard_blocked.append((chapter, f"撞 concept 硬锁: {terms}"))
            continue
        if result["soft"]:
            terms = "; ".join(f"{h['term']}({h['sentence'][:30]})" for h in result["soft"][:5])
            human_confirm.append((chapter, f"soft 命中: {terms}"))
            continue

        # 4) forbidden 条款命中（子串匹配）
        forbidden = _current_volume_forbidden(author_intent, meta.get("vid", ""), chapter)
        hits = [f for f in forbidden if f and f in joined]
        if hits:
            hard_blocked.append((chapter, f"撞 author_intent forbidden: {hits[:3]}"))
            continue

        # 5) 接近伏笔回收边界：由 audit 只作记录（不改条目），归入通过
        passed.append(chapter)

    print(f"=== 中纲草稿校验报告: {path.name} ===")
    print(f"条目总数: {len(entries)}")
    print(f"a) 校验通过: {len(passed)} 章 {sorted(passed)}")
    print(f"b) 需人工确认: {len(human_confirm)} 章")
    for ch, why in human_confirm:
        print(f"   - ch{ch}: {why}")
    print(f"c) 直接撞锁/撞forbidden（需重生成）: {len(hard_blocked)} 章")
    for ch, why in hard_blocked:
        print(f"   - ch{ch}: {why}")
    if empty:
        print(f"[注意] 其中 {len(empty)} 章为空条目: {sorted(empty)}")

    # 退出码：有 hard_blocked → 1（需重生成）；空条目 → 2；否则 0
    if hard_blocked:
        return 1
    if empty:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

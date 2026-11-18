"""Consume the needs_human_review queue into a review worklist.

The orchestrator's `_flag_for_human` appends one record per chapter
(82-87 gray band, dim-gate blocked, spot-read releases, …) to
`audit/needs_human_review.json` — 17k+ records at the 3800-chapter
finish. This script turns that queue into a per-chapter, prioritized
worklist that a human reviewer (or a backfill agent) can work through:

- dedupe per chapter, keeping the highest score + last reason;
- priority tiers:
    P0  score < 60            (low quality, backfill candidate)
    P1  60-81                 (force-best drafts, read-and-decide)
    P2  82-87                 (human review queue proper)
    P3  >=88 dim-gate/spot    (spot-read releases)
- output `audit/review_worklist.json` (the single source a reviewer
  consumes) + a Markdown digest `audit/review_worklist.md`.

Read-only on the queue itself; re-run any time after new queue entries
land. Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.review_worklist [--top N]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "audit" / "needs_human_review.json"
OUT_JSON = ROOT / "audit" / "review_worklist.json"
OUT_MD = ROOT / "audit" / "review_worklist.md"


def tier_of(score: float | None) -> str:
    if score is None or score < 60:
        return "P0"
    if score < 82:
        return "P1"
    if score < 88:
        return "P2"
    return "P3"


def build(top: int | None = None) -> dict:
    raw = json.loads(QUEUE.read_text(encoding="utf-8")) if QUEUE.exists() else {}
    records: dict[int, dict] = {}
    for item in raw.get("queue", []):
        ch = int(item.get("chapter", 0))
        score = item.get("score")
        score = float(score) if score is not None else None
        cur = records.get(ch)
        if cur is None or (score or 0) > (cur.get("score") or 0):
            records[ch] = {"chapter": ch, "score": score,
                           "reason": item.get("reason", ""),
                           "tier": tier_of(score)}
        else:
            # keep the higher score, append distinct reasons
            if item.get("reason") and item["reason"] not in cur["reason"].split("|"):
                cur["reason"] = cur["reason"] + "|" + item["reason"]
            cur["tier"] = tier_of(score)

    chapters = sorted(records.values(),
                      key=lambda r: (r["tier"], r["score"] if r["score"] is not None else -1,
                                     r["chapter"]))
    if top:
        chapters = chapters[:top]
    by_tier = defaultdict(list)
    for r in chapters:
        by_tier[r["tier"]].append(r["chapter"])

    payload = {
        "source": "audit/needs_human_review.json",
        "unique_chapters": len(records),
        "queue_records": len(raw.get("queue", [])),
        "tiers": {t: {"count": len(by_tier.get(t, [])),
                      "chapters": by_tier.get(t, [])}
                   for t in ("P0", "P1", "P2", "P3")},
        "chapters": chapters,
        "sop": [
            "P0 先审：低分/无分章，决定是否人工补写（补写后重新 generate+audit 该片）",
            "P1 次之：force-best draft 章，抽读决定是否保留或补写",
            "P2 82-87 章：人工复核队列本体，逐章过目",
            "P3 ≥88 章：spot-read 抽样即可",
            "审完在对应 draft/novel 文件头部或 quality-backlog 记结论，不改动 checkpoint",
        ],
    }
    return payload


def render_markdown(payload: dict) -> str:
    lines = ["# 人工复核工作清单（review_worklist）", ""]
    lines.append(f"来源队列 {payload['queue_records']} 条 → 去重后 "
                 f"**{payload['unique_chapters']} 章**；分级：")
    lines.append("")
    lines.append("| 级 | 章数 | 口径 |")
    lines.append("|---|---|---|")
    lines.append(f"| P0 | {payload['tiers']['P0']['count']} | <60 / 无分（补写候选） |")
    lines.append(f"| P1 | {payload['tiers']['P1']['count']} | 60-81 force-best |")
    lines.append(f"| P2 | {payload['tiers']['P2']['count']} | 82-87 人工复核队列 |")
    lines.append(f"| P3 | {payload['tiers']['P3']['count']} | ≥88 抽读 |")
    lines += ["", "## P0 章（优先处理）", ""]
    p0 = payload["tiers"]["P0"]["chapters"]
    lines.append("、".join(str(c) for c in p0[:200]) +
                 (" …（余见 JSON）" if len(p0) > 200 else ""))
    lines += ["", "## 完整清单", ""]
    lines.append("| 章 | 级 | 分 | 原因 |")
    lines.append("|---|---|---|---|")
    for r in payload["chapters"][:500]:
        lines.append(f"| ch{r['chapter']} | {r['tier']} | "
                     f"{r['score']} | {r['reason'][:60]} |")
    if len(payload["chapters"]) > 500:
        lines.append(f"| … | | | 余 {len(payload['chapters']) - 500} 章见 JSON |")
    lines += ["", "## SOP", ""]
    lines += [f"- {s}" for s in payload["sop"]]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", type=int, default=None,
                        help="limit the worklist to N chapters")
    parser.add_argument("--no-md", action="store_true",
                        help="skip the Markdown digest")
    args = parser.parse_args(argv)

    if not QUEUE.exists():
        print(f"queue not found: {QUEUE}")
        return 1
    payload = build(args.top)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    print(f"worklist: {payload['unique_chapters']} unique chapters "
          f"(P0={len(payload['tiers']['P0']['chapters'])} "
          f"P1={len(payload['tiers']['P1']['chapters'])} "
          f"P2={len(payload['tiers']['P2']['chapters'])} "
          f"P3={len(payload['tiers']['P3']['chapters'])}) -> {OUT_JSON.name}")
    if not args.no_md:
        OUT_MD.write_text(render_markdown(payload), encoding="utf-8")
        print(f"digest -> {OUT_MD.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

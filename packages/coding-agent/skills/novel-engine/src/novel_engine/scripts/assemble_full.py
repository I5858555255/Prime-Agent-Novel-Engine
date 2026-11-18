"""Assemble the full book into chapters/full/, one file per chapter.

Copy rule: `chapters/novel/chapter_N.txt` wins (≥88 publication line),
fall back to `chapters/draft/chapter_N.txt` (force-best). Chapters with
neither source get a placeholder `chapter_N.txt` marked "待补写" plus,
when available, the isolated reject draft appended from
`chapters/draft/failed/chapter_N/final_gate_reject.txt`. A `_README.md`
lists the sources and the missing-chapter table.

Re-run after human backfill of missing chapters; the assembly is read-only
with respect to the source directories.

Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.assemble_full
"""
from __future__ import annotations

import argparse
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHAPTERS = ROOT / "chapters"
NOVEL = CHAPTERS / "novel"
DRAFT = CHAPTERS / "draft"
FAILED = DRAFT / "failed"


def source_path(n: int) -> Path | None:
    for base in (NOVEL, DRAFT):
        p = base / f"chapter_{n}.txt"
        if p.exists():
            return p
    return None


def reject_path(n: int) -> Path | None:
    p = FAILED / f"chapter_{n}" / "final_gate_reject.txt"
    return p if p.exists() else None


def assemble(total: int, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    from_novel = 0
    from_draft = 0
    placeholders: list[int] = []
    for n in range(1, total + 1):
        dest = out / f"chapter_{n}.txt"
        src = source_path(n)
        if src is not None:
            dest.write_bytes(src.read_bytes())
            if src.parent == NOVEL:
                from_novel += 1
            else:
                from_draft += 1
            continue
        reject = reject_path(n)
        lines = [
            f"# chapter {n} —— 待补写（无已提交正文）",
            "",
            "来源：该章为永久 skip（checkpoint.skipped_chapters），"
            "无 draft/novel 正文。",
        ]
        if reject is not None:
            lines.append("以下为隔离区残稿（chapters/draft/failed 的 "
                         "final_gate_reject.txt），仅供参考：")
            lines.append("")
            lines.append(reject.read_text(encoding="utf-8", errors="replace"))
        dest.write_text("\n".join(lines), encoding="utf-8")
        placeholders.append(n)
    return {"from_novel": from_novel, "from_draft": from_draft,
            "placeholders": placeholders}


def write_readme(out: Path, total: int, stats: dict) -> None:
    lines = [
        "# 全书拼接目录（chapter_1..chapter_%d）" % total,
        "",
        "来源：chapters/novel（≥88 发布线）优先，否则 chapters/draft"
        "（force-best）。每章一个文件：chapter_N.txt（不补零）。",
        "",
        "| 来源 | 章数 |",
        "|---|---|",
        f"| novel（发布线） | {stats['from_novel']} |",
        f"| draft（force-best） | {stats['from_draft']} |",
        f"| 占位（待补写） | {len(stats['placeholders'])} |",
        "",
    ]
    if stats["placeholders"]:
        lines.append("## 待补写章（占位文件，含隔离区残稿如有）")
        lines.append("")
        lines.append("、".join(str(n) for n in stats["placeholders"]))
        lines.append("")
    lines += [
        "注：ch1757 的正文取自 draft（重试稿，canon 硬词被拦后的最优稿）。",
        "",
        f"拼接时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "重跑：python -X utf8 -m novel_engine.scripts.assemble_full",
    ]
    (out / "_README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--total", type=int, default=3800,
                        help="last chapter number (default 3800)")
    parser.add_argument("--out", default=None,
                        help="output dir; default chapters/full")
    args = parser.parse_args(argv)
    out = Path(args.out) if args.out else CHAPTERS / "full"
    if not out.is_absolute():
        out = ROOT / out
    stats = assemble(args.total, out)
    write_readme(out, args.total, stats)
    print(f"assembled {stats['from_novel'] + stats['from_draft']} real "
          f"chapters + {len(stats['placeholders'])} placeholders -> {out}")
    if stats["placeholders"]:
        print("placeholders: " + ", ".join(str(n) for n in stats["placeholders"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

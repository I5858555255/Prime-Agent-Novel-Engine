"""Read-only status snapshot for handoff.

Collects the numbers a new operator needs (checkpoint, produced chapters,
mid-outline coverage, latest batch quality, StateDB row counts) and renders
them as Markdown. Never writes to runtime/ or chapters/.

Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.status_snapshot
    python -X utf8 -m novel_engine.scripts.status_snapshot --out audit/status_snapshot.md
"""
import argparse
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLANNING = ROOT / "config" / "planning"
RUNTIME = ROOT / "runtime"
CHAPTERS = ROOT / "chapters"
LOG_DIR = RUNTIME

END_RE = re.compile(
    r"=== END chapter (\d+) \[([A-Z_]+)\] in ([\d.]+)s \(score=([\d.]+)\)(?: note=(.*))? ===$")

TABLES = ("characters", "factions", "foreshadows", "clue_plans",
          "relationships", "concept_unlocks")


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def chapter_numbers(directory: Path) -> list[int]:
    numbers = []
    if not directory.is_dir():
        return numbers
    for path in directory.glob("chapter_*.txt"):
        stem = path.stem.split("_")[-1]
        if stem.isdigit():
            numbers.append(int(stem))
    return numbers


def mid_outline_summary() -> dict:
    files = sorted(PLANNING.glob("mid_outline_*.json"))
    latest = None
    latest_status = None
    latest_approved = 0
    latest_total = 0
    for path in files:
        data = read_json(path)
        entries = data.get("entries") or {}
        covered = [int(k) for k in entries.keys() if str(k).isdigit()]
        if not covered:
            continue
        meta = data.get("meta") or {}
        status = meta.get("status")
        approved = sum(
            1 for e in entries.values()
            if isinstance(e, dict) and e.get("status") == "approved")
        total = len(entries)
        if latest is None or max(covered) > latest[1]:
            latest = (path.name, max(covered))
            latest_status = status
            latest_approved = approved
            latest_total = total
    return {
        "files": len(files),
        "latest_name": latest[0] if latest else None,
        "latest_max_chapter": latest[1] if latest else None,
        "latest_meta_status": latest_status,
        "approved": latest_approved,
        "entries": latest_total,
    }


def latest_batch(limit: int = 40) -> dict:
    logs = list(LOG_DIR.glob("run_volume_*.log"))
    if not logs:
        return {}
    log = max(logs, key=lambda p: p.stat().st_mtime)
    rows = []
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        match = END_RE.search(line.strip())
        if match:
            rows.append({
                "chapter": int(match.group(1)),
                "status": match.group(2),
                "seconds": float(match.group(3)),
                "score": float(match.group(4)),
                "note": (match.group(5) or "").strip(),
            })
    rows = rows[-limit:]
    committed = [r for r in rows if r["status"] == "COMMITTED"]
    failed = [r for r in rows if r["status"] != "COMMITTED"]
    scores = [r["score"] for r in rows]
    lowest = sorted(rows, key=lambda r: r["score"])[:5]
    return {
        "log": log.name,
        "rows": len(rows),
        "first": rows[0]["chapter"] if rows else None,
        "last": rows[-1]["chapter"] if rows else None,
        "committed": len(committed),
        "failed": len(failed),
        "avg": round(sum(scores) / len(scores), 1) if scores else None,
        "lowest": lowest,
        "failed_rows": failed,
    }


def state_db_counts() -> dict:
    path = ROOT / "runtime" / "state.db"
    if not path.exists():
        return {}
    counts = {}
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return {}
    try:
        for table in TABLES:
            try:
                counts[table] = conn.execute(
                    f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                counts[table] = None
    finally:
        conn.close()
    return counts


def build() -> str:
    cp = read_json(RUNTIME / "checkpoint.json")
    sm = read_json(RUNTIME / "state_machine.json")
    checkpoints = cp.get("checkpoints") or []
    unique = set()
    for item in checkpoints:
        if isinstance(item, dict) and item.get("chapter") is not None:
            unique.add(int(item["chapter"]))
    novel = chapter_numbers(CHAPTERS / "novel")
    draft = chapter_numbers(CHAPTERS / "draft")
    failed_dirs = [p for p in (CHAPTERS / "draft" / "failed").glob("chapter_*")
                   if p.is_dir()] if (CHAPTERS / "draft" / "failed").is_dir() else []
    mid = mid_outline_summary()
    batch = latest_batch()
    db = state_db_counts()

    lines = [
        "# 状态快照",
        "",
        f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}（本地）",
        "",
        "## 运行时状态",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| checkpoint 条目 | {len(checkpoints)}（重复 {len(checkpoints) - len(unique)} 条） |",
        f"| checkpoint 唯一章 | {len(unique)}（最大 ch{max(unique) if unique else '-'}） |",
        f"| last_complete | {cp.get('last_complete')} |",
        f"| failure_counts | {cp.get('failure_counts')} |",
        f"| skipped_chapters | {cp.get('skipped_chapters')} |",
        f"| state_machine current_chapter | {sm.get('current_chapter')} |",
        f"| state_machine phase | {sm.get('phase')} / next={sm.get('next_state')} |",
        f"| total_target | {sm.get('total_target')} |",
        "",
        "## 产物",
        "",
        "| 目录 | 数量 | 编号范围 |",
        "|---|---|---|",
        f"| chapters/novel | {len(novel)} | {min(novel) if novel else '-'}..{max(novel) if novel else '-'} |",
        f"| chapters/draft | {len(draft)} | {min(draft) if draft else '-'}..{max(draft) if draft else '-'} |",
        f"| draft/failed | {len(failed_dirs)} | - |",
        "",
        "## 中纲",
        "",
        f"- 分片数：{mid.get('files')}",
        f"- 覆盖到：ch{mid.get('latest_max_chapter')}（{mid.get('latest_name')}，meta.status={mid.get('latest_meta_status')}）",
        f"- 最新片 entry：{mid.get('approved')} approved / {mid.get('entries')}",
        "",
        "## 最近批次",
        "",
    ]
    if batch:
        lines += [
            f"- 日志：{batch['log']}",
            f"- 窗口：ch{batch['first']}..ch{batch['last']}（{batch['rows']} 章）",
            f"- COMMITTED {batch['committed']} / FAILED {batch['failed']}，均分 {batch['avg']}",
            "",
            "最低 5 章：",
            "",
            "| 章 | 分 | 状态 | note |",
            "|---|---|---|---|",
        ]
        for row in batch["lowest"]:
            lines.append(
                f"| {row['chapter']} | {round(row['score'], 1)} | {row['status']} | {row['note']} |")
        if batch["failed_rows"]:
            lines += ["", "失败章：", ""]
            for row in batch["failed_rows"]:
                lines.append(
                    f"- ch{row['chapter']}（{row['score']}）：{row['note']}")
    else:
        lines.append("- 未找到 run_volume 日志")

    lines += ["", "## StateDB 行数", "", "| 表 | 行数 |", "|---|---|"]
    for table in TABLES:
        lines.append(f"| {table} | {db.get(table)} |")

    lines += ["", "## 下一步提示", ""]
    last = cp.get("last_complete")
    latest_mid = mid.get("latest_max_chapter") or 0
    if isinstance(last, int):
        if latest_mid < last:
            lines.append(
                f"- 中纲只覆盖到 ch{latest_mid}，落后于 last_complete={last}："
                f"下一片应为 ch{latest_mid + 1}-{latest_mid + 30}")
        elif mid.get("latest_meta_status") != "approved":
            lines.append(
                f"- 中纲已覆盖到 ch{latest_mid}，但最新片 meta.status="
                f"{mid.get('latest_meta_status')}、approved "
                f"{mid.get('approved')}/{mid.get('entries')}："
                f"先跑 audit_mid_outline 并逐条 approved，再起批次")
        else:
            lines.append(f"- 中纲已覆盖到 ch{latest_mid}，最新片已 approved，可继续下一批")
        next_batch = latest_mid if latest_mid >= last else last
        gate = "" if mid.get("latest_meta_status") == "approved" else "（中纲 approved 后）"
        lines.append(
            f"- 下一批命令{gate}：run_volume --chapters {next_batch} --resume"
            f"（仅在当前批次收敛后执行）")
    lines.append("- 详细交接见 docs/HANDOFF.md；历史决策见 docs/superpowers/quality-backlog.md")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a read-only status snapshot.")
    parser.add_argument("--out", default=None,
                        help="Write Markdown to this path instead of stdout")
    args = parser.parse_args(argv)
    text = build()
    if args.out:
        out = Path(args.out)
        if not out.is_absolute():
            out = ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(out)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

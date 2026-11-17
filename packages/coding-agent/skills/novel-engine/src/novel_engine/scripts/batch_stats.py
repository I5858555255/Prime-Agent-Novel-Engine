"""Batch quality stats from run_volume logs (the broadcast numbers).

Parses the `=== END chapter N [COMMITTED|FAILED] in Xs (score=Y)` lines of
the newest (or a specific) `run_volume_*.log` and prints the summary a
periodic broadcast needs: window, COMMITTED/FAILED counts, average score,
lowest-5 chapters, and the failure-note breakdown. Read-only.

Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.batch_stats
    python -X utf8 -m novel_engine.scripts.batch_stats --log <path> --limit 40
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parents[1] / "runtime"

# Line shape: `=== END chapter N [STATUS] in Xs (score=Y) note=... ===`
# (score lines without a note stop at `(score=Y) ===`). The note text may
# contain balanced `])` pairs (hard-gate lists), so capture the whole tail
# after `note=`; the `best X < 88` prefix is split off at parse time.
END_RE = re.compile(
    r"=== END chapter (\d+) \[([A-Z_]+)\] in ([\d.]+)s \(score=([0-9.]+|None)\)"
    r"(?: ?note=([^\n]*))?$")


def parse(path: Path, limit: int) -> list[dict]:
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = END_RE.search(line)
        if not m:
            continue
        score = m.group(4)
        note = (m.group(5) or "").strip()
        # Strip the trailing " ===" and keep only the human-readable
        # `best X < 88` prefix (the hard-gate list is noise for broadcast).
        if note.endswith(" ==="):
            note = note[:-4].rstrip()
        if " (hard gate [" in note:
            note = note[:note.index(" (hard gate [")].rstrip()
        rows.append({
            "chapter": int(m.group(1)),
            "status": m.group(2),
            "seconds": float(m.group(3)),
            "score": None if score == "None" else float(score),
            "note": note,
        })
    return rows[-limit:]


def summarize(rows: list[dict]) -> int:
    if not rows:
        print("no END lines found")
        return 1
    committed = [r for r in rows if r["status"] == "COMMITTED"]
    failed = [r for r in rows if r["status"] != "COMMITTED"]
    scored = [r for r in rows if r["score"] is not None]
    low = sorted((r for r in rows if r["score"] is not None),
                 key=lambda r: r["score"])[:5]

    print(f"window: ch{rows[0]['chapter']}..ch{rows[-1]['chapter']} "
          f"({len(rows)} END lines)")
    print(f"COMMITTED {len(committed)} / FAILED {len(failed)}")
    if scored:
        print(f"avg score {sum(r['score'] for r in scored) / len(scored):.1f} "
              f"({len(rows) - len(scored)} chapters with score=None)")
    if low:
        print("lowest 5:")
        for r in low:
            print(f"  ch{r['chapter']} {r['score']} [{r['status']}] "
                  f"{r['note'][:80]}")
    if failed:
        print("failed chapters:")
        for r in failed:
            print(f"  ch{r['chapter']} (score={r['score']}) "
                  f"{r['note'][:120]}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", default=None,
                        help="specific log path; default: newest "
                             "runtime/run_volume_*.log")
    parser.add_argument("--limit", type=int, default=40,
                        help="how many recent END lines to summarize")
    args = parser.parse_args(argv)

    if args.log:
        path = Path(args.log)
        if not path.is_absolute():
            # Accept both bare log names and src-relative paths.
            candidate = LOG_DIR / args.log
            if candidate.exists():
                path = candidate
            else:
                path = Path(args.log)
        if not path.exists():
            print(f"log not found: {path}")
            return 1
    else:
        logs = list(LOG_DIR.glob("run_volume_*.log"))
        if not logs:
            print(f"no run_volume logs in {LOG_DIR}")
            return 1
        path = max(logs, key=lambda p: p.stat().st_mtime)
    print(f"log: {path.name}")
    return summarize(parse(path, args.limit))


if __name__ == "__main__":
    sys.exit(main())

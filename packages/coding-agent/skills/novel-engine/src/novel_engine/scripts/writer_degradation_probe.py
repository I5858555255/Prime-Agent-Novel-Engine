"""Writer degradation probe (quality/writer_degradation_probe.py 的脚本化).

Detects the three writer failure modes observed at ch1682 (score 15.5)
and recurring in low-score chapters:

1. **single-char lines** — tokenizer fragmentation producing lines like
   "。\\n一\\n个\\n字"; ratio of single-char lines > threshold.
2. **repetition** — an n-gram (default 4-grams, CJK-aware) whose share of
   the chapter exceeds threshold (e.g. "尸位素餐" 复读十余次).
3. **shortness** — chapter length far below the batch median.

Run on a draft dir (or a single file); prints a report and can write a
JSON sidecar. Read-only. Usage (from the package `src/` directory):

    python -X utf8 -m novel_engine.scripts.writer_degradation_probe \
        --dir novel_engine/chapters/draft --limit 50 [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(__file__).resolve().parents[2]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

SINGLE_CHAR_RE = re.compile(r"^[^\n]$")
_CJK = re.compile(r"[\u4e00-\u9fff]")


def _lines_of(text: str) -> list[str]:
    return [l for l in text.splitlines() if l.strip()]


def single_char_ratio(text: str) -> float:
    lines = _lines_of(text)
    if not lines:
        return 0.0
    one_char = sum(1 for l in lines if len(l.strip()) == 1)
    return one_char / len(lines)


def top_ngram_repetition(text: str, n: int = 4, limit: int = 5) -> list[tuple[str, int, float]]:
    """Most frequent n-grams over CJK text; return (gram, count, share)."""
    cjk = "".join(_CJK.findall(text))
    if len(cjk) < n:
        return []
    grams: dict[str, int] = {}
    for i in range(len(cjk) - n + 1):
        g = cjk[i:i + n]
        grams[g] = grams.get(g, 0) + 1
    total = len(cjk) - n + 1
    ranked = sorted(grams.items(), key=lambda kv: -kv[1])[:limit]
    return [(g, c, round(c / total, 4)) for g, c in ranked]


def probe_chapter(path: Path, median_len: float,
                  sc_threshold: float = 0.10,
                  rep_threshold: float = 0.05,
                  short_ratio: float = 0.6) -> dict | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    sc = round(single_char_ratio(text), 4)
    top = top_ngram_repetition(text)
    top_rep = top[0] if top else ("", 0, 0.0)
    flags: list[str] = []
    if sc > sc_threshold:
        flags.append(f"single-char lines {sc:.0%} > {sc_threshold:.0%}")
    if top_rep[2] > rep_threshold:
        flags.append(f"4-gram '{top_rep[0]}' x{top_rep[1]} "
                     f"({top_rep[2]:.1%} of CJK) > {rep_threshold:.0%}")
    if median_len and len(text) < median_len * short_ratio:
        flags.append(f"length {len(text)} < {short_ratio} x median "
                     f"{int(median_len)}")
    if not flags:
        return None
    return {
        "file": str(path.name),
        "length": len(text),
        "single_char_ratio": sc,
        "top_ngram": top_rep[0],
        "top_ngram_count": top_rep[1],
        "top_ngram_share": top_rep[2],
        "flags": flags,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=None,
                        help="chapter dir (default chapters/draft)")
    parser.add_argument("--limit", type=int, default=50,
                        help="probe the N smallest chapters first")
    parser.add_argument("--json", action="store_true",
                        help="write a JSON sidecar next to the report")
    args = parser.parse_args(argv)

    d = Path(args.dir) if args.dir else ROOT / "chapters" / "draft"
    files = sorted(d.glob("chapter_*.txt"),
                   key=lambda p: int(p.stem.split("_")[-1])
                   if p.stem.split("_")[-1].isdigit() else 0)
    if not files:
        print(f"no chapter files in {d}")
        return 1

    lens = [f.stat().st_size for f in files]
    median_len = statistics.median(lens)
    targets = sorted(files, key=lambda f: f.stat().st_size)[:args.limit]

    hits: list[dict] = []
    for f in targets:
        hit = probe_chapter(f, median_len)
        if hit:
            hits.append(hit)

    print(f"probed {len(targets)} smallest of {len(files)} chapters "
          f"(median length {int(median_len)} chars)")
    print(f"degraded: {len(hits)}")
    for h in hits:
        print(f"  {h['file']}: {'; '.join(h['flags'])}")
    if args.json:
        out = d / "writer_degradation_report.json"
        out.write_text(json.dumps({"median_len": int(median_len),
                                   "probed": len(targets),
                                   "hits": hits}, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        print(f"json -> {out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

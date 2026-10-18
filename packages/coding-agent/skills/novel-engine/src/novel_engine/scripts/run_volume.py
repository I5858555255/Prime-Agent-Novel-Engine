"""Batch runner: generate chapters 1..N using real LLM calls.

Usage (run from src/):
    python -m novel_engine.scripts.run_volume [--chapters N] [--resume]

Outputs are logged to runtime/run_volume_<iso-ts>.log and printed to stdout.
Failures in a single chapter do NOT abort the run; they are recorded and the
loop continues to the next chapter number.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Allow running as `python -m novel_engine.scripts.run_volume` from the src dir.
_SRC_ROOT = str(Path(__file__).resolve().parents[2])
if _SRC_ROOT not in sys.path:
    sys.path.insert(0, _SRC_ROOT)

from novel_engine.core.checkpoint import CheckpointManager  # noqa: E402

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# Same ROOT as agent_api.py: src/novel_engine/ (config/, runtime/, memory/ live here)
ROOT = Path(__file__).resolve().parents[1]

LOG_DIR = ROOT / "runtime"
LOG_DIR.mkdir(exist_ok=True)


def _build_logger(log_path: Path) -> logging.Logger:
    logger = logging.getLogger("run_volume")
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%dT%H:%M:%S%z")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(fh)
    logger.addHandler(sh)
    return logger


# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

def _load_env() -> None:
    """Load .env from the source directory (same logic as agent_api)."""
    for candidate in (ROOT / ".env", ROOT.parent / ".env"):
        if candidate.exists():
            try:
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip().strip('"').strip("'")
                    os.environ.setdefault(key, val)
            except Exception as exc:  # pragma: no cover
                logging.getLogger(__name__).warning("Failed to parse .env at %s: %s", candidate, exc)
            return


def _check_keys(logger: logging.Logger) -> None:
    """Check that required API keys are present in environment."""
    api_key_env = (os.environ.get("LLM_API_KEY") or os.environ.get("AGNES_API_KEY")
                   or os.environ.get("ZLEAP_MODEL_API_KEY"))
    if not api_key_env:
        logger.error("No API key found (LLM_API_KEY, AGNES_API_KEY, or ZLEAP_MODEL_API_KEY). Aborting.")
        sys.exit(1)
    logger.info("API key is present in environment.")


def _check_api_connectivity(logger: logging.Logger) -> None:
    """Lightweight connectivity probe against siliconflow API."""
    import urllib.request
    api_key = os.environ.get("LLM_API_KEY") or os.environ.get("AGNES_API_KEY") or ""
    url = "https://api.siliconflow.cn/v1/models"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        resp = urllib.request.urlopen(req, timeout=10)
        status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except Exception as exc:  # pragma: no cover
        logger.error("API connectivity probe failed: %s", exc)
        logger.error("Aborting. Fix connectivity before re-running.")
        sys.exit(1)
    else:
        logger.info("API connectivity probe returned HTTP %s.", status)


def _get_committed_chapters(logger: logging.Logger, root: Path | None = None) -> set[int]:
    """Return the set of already committed chapter numbers from checkpoint.

    root may be injected for hermetic tests; defaults to the production ROOT.
    """
    cp_mgr = CheckpointManager(str(root or ROOT))
    data = cp_mgr.load()
    committed: set[int] = set()
    for entry in data.get("checkpoints", []):
        if entry.get("complete") is True:
            committed.add(int(entry["chapter"]))
    logger.info("Found %d already completed chapters in checkpoint.", len(committed))
    if committed:
        logger.info("Committed chapters: %s", sorted(committed))
    return committed


def _get_failure_counts(logger: logging.Logger, root: Path | None = None) -> dict:
    """Return cross-batch failure counts {chapter_str: count} from checkpoint."""
    cp_mgr = CheckpointManager(str(root or ROOT))
    counts = cp_mgr.get_failure_counts()
    over = {int(k): v for k, v in counts.items() if v > 0}
    if over:
        logger.info("Cross-batch failure counts: %s", sorted(over.items()))
    return counts


# ---------------------------------------------------------------------------
# Chapter runner
# ---------------------------------------------------------------------------

# 跨批次累计失败超过该轮数后，策略性跳过该章（不再每批重试）。
# 跳过不写入 world state，后续章从上一 committed 章续接；剧情缺口由验收轮
# 记入 backlog 待用户拍板是否人工补写。
DEFAULT_SKIP_AFTER = 5


def _should_skip(chapter: int, failure_counts: dict, skip_after: int) -> bool:
    """累计失败轮数 > skip_after 时跳过该章。"""
    return failure_counts.get(str(chapter), 0) > skip_after


async def _run_one(chapter_num: int, logger: logging.Logger, root: Path) -> dict:
    from novel_engine.agent_api import generate_chapter  # noqa: E402
    t0 = time.monotonic()
    logger.info("=== START chapter %d ===", chapter_num)
    try:
        result = await generate_chapter(chapter_num, project_root=str(root), use_mock=False)
    except Exception as exc:  # pragma: no cover - defensive
        elapsed = time.monotonic() - t0
        logger.error("chapter %d FAILED after %.1fs: %s", chapter_num, elapsed, exc)
        return {"chapter": chapter_num, "success": False, "error": str(exc), "elapsed_s": elapsed}
    elapsed = time.monotonic() - t0
    ok = result.get("success", False)
    status = "COMMITTED" if ok else "FAILED"
    logger.info(
        "=== END chapter %d [%s] in %.1fs (score=%s) note=%s ===",
        chapter_num, status, elapsed, result.get("score"),
        result.get("note") or result.get("human_review_note") or result.get("final_gate_violations") or "",
    )
    if not ok:
        logger.error("chapter %d errors: %s", chapter_num, result.get("errors"))
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main_async(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run real LLM chapter generation for chapters 1..N.")
    parser.add_argument("--chapters", type=int, default=10, help="Number of chapters to generate (default 10).")
    parser.add_argument("--resume", action="store_true",
                        help="Skip chapters already COMMITTED and start from the first missing one.")
    parser.add_argument("--skip-after", type=int, default=DEFAULT_SKIP_AFTER,
                        help="Skip a chapter after this many cumulative cross-batch failures (default 5).")
    args = parser.parse_args(argv)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = LOG_DIR / f"run_volume_{ts}.log"
    logger = _build_logger(log_path)
    logger.info("run_volume started — log: %s", log_path)

    _load_env()
    _check_keys(logger)
    _check_api_connectivity(logger)

    # Load committed chapters from checkpoint
    committed = _get_committed_chapters(logger)
    failure_counts = _get_failure_counts(logger)
    cp_mgr = CheckpointManager(str(ROOT))
    already_skipped = cp_mgr.get_skipped_chapters()
    if already_skipped:
        logger.info("Previously skipped chapters (will not retry): %s", sorted(already_skipped))

    # Determine which chapters to run
    chapters_to_run = list(range(1, args.chapters + 1))

    if args.resume:
        # Skip already committed
        chapters_to_run = [c for c in chapters_to_run if c not in committed]
        if not chapters_to_run:
            logger.info("All requested chapters are already COMMITTED. Nothing to do.")
            return 0
        logger.info("Resuming from chapter %d (skipped %d already-committed)",
                    chapters_to_run[0], len(committed & set(chapters_to_run)))
    else:
        skipped = [c for c in chapters_to_run if c in committed]
        if skipped:
            logger.warning("Chapters already COMMITTED and will be regenerated: %s", skipped)
            logger.warning("Use --resume to skip already-committed chapters.")

    logger.info("Generating chapters %d..%d (real LLM, no mock).", chapters_to_run[0], chapters_to_run[-1])

    # Initialize world state if needed
    logger.info("Initializing/verifying world state...")
    from novel_engine.agent_api import init_state  # noqa: E402
    try:
        init_result = await init_state(project_root=str(ROOT))
        logger.info("World state initialized: current_chapter=%s", init_result.get("current_chapter"))
    except Exception as exc:  # pragma: no cover
        logger.warning("World state init warning: %s", exc)

    t_all = time.monotonic()
    results: list[dict] = []
    for ch in chapters_to_run:
        if ch in already_skipped:
            results.append({"chapter": ch, "success": False, "skipped": True, "elapsed_s": 0.0})
            logger.info("=== SKIP chapter %d (already abandoned by skip-after policy) ===", ch)
            continue
        if _should_skip(ch, failure_counts, args.skip_after):
            logger.info("=== SKIP chapter %d (cumulative failures %d > %d) ===",
                        ch, failure_counts.get(str(ch), 0), args.skip_after)
            cp_mgr.mark_skipped(ch)
            results.append({"chapter": ch, "success": False, "skipped": True, "elapsed_s": 0.0})
            continue
        res = await _run_one(ch, logger, ROOT)
        if res.get("success"):
            cp_mgr.reset_failure(ch)
        else:
            new_count = cp_mgr.record_failure(ch)
            if new_count > args.skip_after:
                # 超过阈值：当场放弃该章，后续批次不再重试
                logger.info("=== SKIP chapter %d (cumulative failures %d > %d) ===",
                            ch, new_count, args.skip_after)
                cp_mgr.mark_skipped(ch)
                res = {"chapter": ch, "success": False, "skipped": True,
                       "elapsed_s": res.get("elapsed_s", 0)}
            else:
                logger.warning("chapter %d cumulative failure count now %d (skip threshold %d)",
                               ch, new_count, args.skip_after)
        results.append(res)

    total_elapsed = time.monotonic() - t_all

    succeeded = sum(1 for r in results if r.get("success"))
    failed = sum(1 for r in results if not r.get("success") and not r.get("skipped"))
    skipped_count = sum(1 for r in results if r.get("skipped"))
    logger.info("=" * 60)
    logger.info("SUMMARY: %d/%d chapters succeeded, %d failed, %d skipped in %.1fs",
                succeeded, len(results), failed, skipped_count, total_elapsed)
    for r in results:
        if r.get("skipped"):
            logger.info("  [SKIP] chapter %s — abandoned by skip-after policy", r.get("chapter", "?"))
        else:
            flag = "OK" if r.get("success") else "FAIL"
            logger.info("  [%s] chapter %s — score=%s elapsed=%.1fs",
                        flag, r.get("chapter", "?"), r.get("score"), r.get("elapsed_s", 0))
    logger.info("Log: %s", log_path)
    return 0 if failed == 0 else 1


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(main_async(argv))


if __name__ == "__main__":
    sys.exit(main())

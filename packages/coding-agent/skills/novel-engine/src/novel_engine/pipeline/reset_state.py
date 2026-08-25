"""
Shared helpers for the Mini / Medium / Production runners.

Centralises the runtime-state reset and the two verification blocks that were
previously copy-pasted across `mini_test_runner.py`, `medium_test_runner.py`
and `production_runner.py`.
"""
import json
import logging
import shutil
from pathlib import Path

logger = logging.getLogger("novel_engine.run_utils")


def reset_runtime_state(root: Path):
    """清理运行时状态，确保每次运行从零开始。"""
    # 单个需删除的 JSON 文件
    for sub in (
        "runtime/checkpoint.json",
        "runtime/state_machine.json",
        "runtime/recovery_policy.json",
        "runtime/session_tree.json",
        "audit/per_chapter_reviews.json",
        "audit/sliding_window_reviews.json",
        "memory/quality_memory.json",
    ):
        p = root / sub
        if p.exists():
            try:
                p.unlink()
            except (PermissionError, OSError):
                pass

    # 需清空（删除后重建）的目录
    for sub in (
        "chapters/novel",
        "chapters/synopsis",
        "chapters/outline",
        "audit",
        "memory/short_term",
        "memory/long_term",
        "memory/world_state",
    ):
        p = root / sub
        if p.exists():
            try:
                shutil.rmtree(p)
            except (PermissionError, OSError):
                _safe_clear(p)
        (root / sub).mkdir(parents=True, exist_ok=True)

    # 重新创建必要的目录结构
    for sub in (
        "runtime/logs",
        "chapters/novel",
        "chapters/synopsis",
        "chapters/outline",
        "audit",
        "memory/short_term",
        "memory/long_term",
        "memory/world_state/pending",
        "memory/long_term/embeddings",
    ):
        (root / sub).mkdir(parents=True, exist_ok=True)


def verify_output_files(project_root: Path, results, num_chapters: int):
    """确认每章的 novel / synopsis / outline 文件均已写出。"""
    for i in range(1, min(len(results) + 1, num_chapters + 1)):
        novel_path = project_root / "chapters" / "novel" / f"chapter_{i}.txt"
        synopsis_path = project_root / "chapters" / "synopsis" / f"chapter_{i}.txt"
        outline_path = project_root / "chapters" / "outline" / f"chapter_{i}.json"

        if novel_path.exists() and synopsis_path.exists() and outline_path.exists():
            novel_size = novel_path.stat().st_size
            logger.info(f"Chapter {i} files OK (novel: {novel_size} bytes)")
        else:
            logger.warning(f"Chapter {i} missing files!")


def verify_recovery_policy(project_root: Path):
    """确认 recovery_policy.json 包含全部分流键。"""
    rp_path = project_root / "runtime" / "recovery_policy.json"
    if rp_path.exists():
        with open(rp_path, "r", encoding="utf-8") as f:
            policy = json.load(f)
        expected_keys = [
            "json_parse_error", "api_disconnect", "context_overflow",
            "world_state_conflict", "file_write_corruption", "unknown_error",
        ]
        for key in expected_keys:
            assert key in policy, f"Missing recovery policy: {key}"
        logger.info("OK Recovery policy complete")


def _safe_clear(p: Path):
    """Best-effort recursive clear of a directory's contents."""
    for child in p.iterdir():
        try:
            if child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
        except (PermissionError, OSError):
            pass

"""Hermetic regression tests: run_volume --skip-after 跨批次失败跳过机制.

覆盖：
1. CheckpointManager 失败计数持久化（record/reset/get）
2. 跳过标记持久化（mark/get）
3. _should_skip 阈值判定（> skip_after 才跳）
4. main_async 集成：失败累加 → 超阈值跳过 → 成功清零 → 已放弃章不再重试
"""
from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch

import pytest

from novel_engine.core.checkpoint import CheckpointManager
from novel_engine.scripts.run_volume import DEFAULT_SKIP_AFTER, _should_skip, main_async

# asyncio event loop 初始化需要 socketpair（conftest 默认拦截真实网络）。
# 本文件不发任何真实网络请求（LLM/API 全部被 patch），仅放行 loop 自举。
pytestmark = pytest.mark.allow_network


class TestCheckpointFailureCounts(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.tempdir())
        (self.root / "runtime").mkdir(parents=True, exist_ok=True)

    @staticmethod
    def tempdir() -> str:
        import tempfile
        return tempfile.mkdtemp(prefix="skip_after_test_")

    def test_failure_counts_persist_across_instances(self) -> None:
        mgr = CheckpointManager(str(self.root))
        self.assertEqual(mgr.get_failure_counts(), {})
        self.assertEqual(mgr.record_failure(370), 1)
        self.assertEqual(mgr.record_failure(370), 2)
        mgr.record_failure(584)
        # 新实例读到同一持久化文件
        again = CheckpointManager(str(self.root))
        counts = again.get_failure_counts()
        self.assertEqual(counts.get("370"), 2)
        self.assertEqual(counts.get("584"), 1)

    def test_reset_failure_clears_key(self) -> None:
        mgr = CheckpointManager(str(self.root))
        mgr.record_failure(370)
        mgr.record_failure(370)
        mgr.reset_failure(370)
        self.assertEqual(mgr.get_failure_counts().get("370"), None)
        # 重置不影响其他章
        mgr.record_failure(584)
        mgr.reset_failure(370)
        self.assertEqual(mgr.get_failure_counts().get("584"), 1)

    def test_skipped_chapters_persist(self) -> None:
        mgr = CheckpointManager(str(self.root))
        self.assertEqual(mgr.get_skipped_chapters(), set())
        mgr.mark_skipped(370)
        mgr.mark_skipped(370)  # 幂等
        self.assertEqual(CheckpointManager(str(self.root)).get_skipped_chapters(), {370})

    def test_should_skip_threshold(self) -> None:
        counts = {"370": 6, "584": 5, "650": 13}
        self.assertTrue(_should_skip(370, counts, DEFAULT_SKIP_AFTER))
        # 等于阈值不跳（> 5）
        self.assertFalse(_should_skip(584, counts, DEFAULT_SKIP_AFTER))
        self.assertTrue(_should_skip(650, counts, DEFAULT_SKIP_AFTER))
        # 无记录不跳
        self.assertFalse(_should_skip(999, {}, DEFAULT_SKIP_AFTER))
        # 自定义阈值
        self.assertTrue(_should_skip(584, counts, 4))
        self.assertFalse(_should_skip(584, counts, 5))


class TestRunVolumeSkipIntegration(unittest.TestCase):
    # 共享 event loop：Windows ProactorEventLoop 反复 asyncio.run 会触发 __del__ 异常
    _LOOP: asyncio.AbstractEventLoop | None = None

    @classmethod
    def _get_loop(cls) -> asyncio.AbstractEventLoop:
        if cls._LOOP is None:
            cls._LOOP = asyncio.new_event_loop()
        return cls._LOOP

    def setUp(self) -> None:
        import tempfile
        self.root = Path(tempfile.mkdtemp(prefix="skip_after_run_"))
        # 预置 checkpoint 目录
        (self.root / "runtime").mkdir(parents=True, exist_ok=True)

    def _run_main(self, chapters: int, skip_after: int, fail_chapters: set[int]) -> int:
        """跑 main_async：monkeypatch 掉网络/环境与真实生成，失败章由 fail_chapters 控制。"""
        async def fake_generate_chapter(chapter: int, project_root: str, use_mock: bool) -> dict:
            if chapter in fail_chapters:
                return {"success": False, "score": None, "errors": ["fake fail"], "note": ""}
            return {"success": True, "score": 70.0, "errors": [], "note": ""}

        async def fake_init_state(project_root: str) -> dict:
            return {"current_chapter": 1}

        with patch("novel_engine.scripts.run_volume._load_env"), \
             patch("novel_engine.scripts.run_volume._check_keys"), \
             patch("novel_engine.scripts.run_volume._check_api_connectivity"), \
             patch("novel_engine.scripts.run_volume.ROOT", self.root), \
             patch("novel_engine.scripts.run_volume.LOG_DIR", self.root / "runtime"), \
             patch("novel_engine.agent_api.generate_chapter", new=fake_generate_chapter), \
             patch("novel_engine.agent_api.init_state", new=fake_init_state):
            return self._get_loop().run_until_complete(
                main_async(["--chapters", str(chapters), "--resume", "--skip-after", str(skip_after)])
            )

    def test_failures_accumulate_and_skip_after_threshold(self) -> None:
        # 第一轮：370 失败 → 计数 1；第二轮计数超 5 → SKIP
        for _ in range(6):
            self._run_main(chapters=370, skip_after=5, fail_chapters={370})
        mgr = CheckpointManager(str(self.root))
        self.assertEqual(mgr.get_failure_counts().get("370"), 6)
        self.assertIn(370, mgr.get_skipped_chapters())

    def test_success_resets_count(self) -> None:
        # 370 失败两次后成功一次 → 计数清零
        self._run_main(chapters=370, skip_after=5, fail_chapters={370})
        self._run_main(chapters=370, skip_after=5, fail_chapters={370})
        mgr = CheckpointManager(str(self.root))
        self.assertEqual(mgr.get_failure_counts().get("370"), 2)
        self._run_main(chapters=370, skip_after=5, fail_chapters=set())
        self.assertEqual(mgr.get_failure_counts().get("370"), None)
        self.assertNotIn(370, mgr.get_skipped_chapters())

    def test_skipped_chapter_not_retried(self) -> None:
        # 已放弃章在后续 --resume 中直接 SKIP，不再触发生成
        mgr = CheckpointManager(str(self.root))
        for _ in range(6):
            self._run_main(chapters=370, skip_after=5, fail_chapters={370})
        self.assertIn(370, mgr.get_skipped_chapters())
        # 第 7 轮：即使模拟"现在能成功"，已放弃章仍不重试 → 不写入 checkpoint
        self._run_main(chapters=370, skip_after=5, fail_chapters=set())
        self.assertIsNone(mgr.get_checkpoint_by_chapter(370))
        # 且计数不再增长
        self.assertEqual(mgr.get_failure_counts().get("370"), 6)


if __name__ == "__main__":
    unittest.main()

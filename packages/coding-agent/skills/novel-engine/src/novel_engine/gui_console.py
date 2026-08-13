#!/usr/bin/env python3
"""
GUI 控制台：提供进度跟踪和状态显示。
用于可视化章节生成流程。
"""
import sys
import time
from pathlib import Path
from typing import Optional


class GuiConsole:
    """图形化控制台，显示生成进度和状态。"""

    def __init__(self, project_root: str | Path = "小说工程"):
        self.root = Path(project_root)
        self.start_time = None
        self.current_chapter = 0
        self.total_chapters = 0
        self.passed = 0
        self.failed = 0
        self.scores: list[float] = []

    def start(self, total_chapters: int):
        """开始新的测试运行。"""
        self.start_time = time.time()
        self.total_chapters = total_chapters
        self.current_chapter = 0
        self.passed = 0
        self.failed = 0
        self.scores = []
        self._print_header()

    def _print_header(self):
        """打印测试头部信息。"""
        print("=" * 70)
        print(f"  小说工程 - 自动化测试控制台")
        print(f"  项目路径: {self.root}")
        print(f"  总章节数: {self.total_chapters}")
        print("=" * 70)
        print()

    def chapter_start(self, chapter_num: int):
        """开始生成某一章。"""
        self.current_chapter = chapter_num
        progress = (chapter_num / self.total_chapters) * 100
        bar_len = 40
        filled = int(bar_len * chapter_num / self.total_chapters)
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r[{bar}] {progress:5.1f}% | Chapter {chapter_num}/{self.total_chapters}", end="", flush=True)

    def chapter_end(self, result: dict):
        """完成某一章的生成。"""
        status = "PASS" if result.get("success") else "FAIL"
        score = result.get("score", "N/A")
        errors = result.get("errors", [])

        if result.get("success"):
            self.passed += 1
            if score is not None:
                self.scores.append(score)
        else:
            self.failed += 1

        # 移动到下一行并显示结果
        print(f"\n  [{status}] Score: {score} | Errors: {len(errors)}")

        if errors:
            for err in errors[:3]:  # 只显示前3个错误
                print(f"    WARNING {err}")

    def show_summary(self):
        """显示最终摘要。"""
        elapsed = time.time() - self.start_time if self.start_time else 0

        print("\n" + "=" * 70)
        print("  测试结果摘要")
        print("=" * 70)
        print(f"  总章节数:   {self.total_chapters}")
        print(f"  通过:       {self.passed}")
        print(f"  失败:       {self.failed}")
        print(f"  通过率:     {(self.passed / self.total_chapters * 100):.1f}%")
        if self.scores:
            print(f"  平均分数:   {sum(self.scores) / len(self.scores):.1f}")
            print(f"  最低分数:   {min(self.scores):.1f}")
            print(f"  最高分数:   {max(self.scores):.1f}")
        else:
            print("  平均分数:   N/A")
            print("  最低分数:   N/A")
            print("  最高分数:   N/A")
        print(f"  耗时:       {elapsed:.2f}秒")
        print("=" * 70)

        if self.failed == 0:
            print("\n  MINI TEST PASSED")
        else:
            print(f"\n  MINI TEST FAILED ({self.failed} chapters failed)")

        print()

    def log(self, message: str):
        """记录日志消息。"""
        print(f"  INFO {message}")

    def error(self, message: str):
        """记录错误消息。"""
        print(f"  ERROR: {message}")

    def warning(self, message: str):
        """记录警告消息。"""
        print(f"  WARNING: {message}")


if __name__ == "__main__":
    console = GuiConsole()
    console.start(10)
    for i in range(1, 11):
        console.chapter_start(i)
        # 模拟生成
        time.sleep(0.1)
        result = {"success": True, "score": 85.0, "errors": []}
        console.chapter_end(result)
    console.show_summary()

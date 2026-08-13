"""
记忆管理器：管理 short_term、long_term、world_state、quality_memory。
支持 RAG 检索、滑动窗口审查、质量记忆刷新。
"""
import json
import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


class MemoryManager:
    """记忆管理器：读写各类记忆文件。"""

    def __init__(self, project_root: str | Path = "小说工程"):
        self.root = Path(project_root)
        # 确保所有必要的记忆目录存在
        for sub_dir in ("short_term", "long_term", "world_state", "world_state/pending",
                        "long_term/embeddings"):
            (self.root / "memory" / sub_dir).mkdir(parents=True, exist_ok=True)

    def _load_json(self, path: Path) -> dict:
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, ValueError):
                return {}
        return {}

    def _save_json(self, path: Path, data: dict):
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _get_low_threshold(self) -> int:
        """从配置文件读取低分阈值（fix分界线）。"""
        config_path = self.root / "config" / "quality_thresholds.json"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                return config.get("grading", {}).get("fix", 60)
            except (json.JSONDecodeError, ValueError):
                pass
        return 60

    # ====== Short-term Memory ======

    def add_recent_chapter(self, chapter_num: int, summary: dict):
        """向短期记忆添加章节摘要。"""
        recent_file = self.root / "memory" / "short_term" / "recent_chapters.json"
        data = self._load_json(recent_file)
        data.setdefault("recent_chapters", []).append({
            "chapter": chapter_num,
            **summary,
        })
        # 保留最近80章
        data["recent_chapters"] = data["recent_chapters"][-80:]
        self._save_json(recent_file, data)

    def get_recent_summaries(self, chapter_num: int, count: int = 80) -> list[dict]:
        """获取最近 N 章摘要。"""
        recent_file = self.root / "memory" / "short_term" / "recent_chapters.json"
        data = self._load_json(recent_file)
        recent = data.get("recent_chapters", [])
        return recent[-count:]

    # ====== Long-term Memory ======

    def update_chapter_index(self, chapter_num: int, keywords: list[str]):
        """更新全量章节关键词索引。"""
        index_file = self.root / "memory" / "long_term" / "chapter_index.json"
        data = self._load_json(index_file)
        entries = data.get("entries", {})
        entries[str(chapter_num)] = {
            "chapter": chapter_num,
            "keywords": list(set(keywords)),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        data["entries"] = entries
        self._save_json(index_file, data)

    def retrieve_by_keywords(self, keywords: list[str], limit: int = 10) -> list[dict]:
        """基于关键词检索历史章节。"""
        index_file = self.root / "memory" / "long_term" / "chapter_index.json"
        data = self._load_json(index_file)
        entries = data.get("entries", {})

        scored = []
        for chapter_str, entry in entries.items():
            entry_keywords = set(entry.get("keywords", []))
            match_count = len(entry_keywords & set(keywords))
            if match_count > 0:
                scored.append((match_count, int(chapter_str), entry))

        scored.sort(key=lambda x: (-x[0], -x[1]))
        return [entry for _, _, entry in scored[:limit]]

    # ====== World State ======

    def load_world_state(self) -> dict:
        """加载完整 world_state。"""
        state = {}
        for filename in ["characters.json", "factions.json", "locations.json",
                         "items.json", "power_system.json", "timeline.json",
                         "relationships.json"]:
            state[Path(filename).stem] = self._load_json(
                self.root / "memory" / "world_state" / filename
            )
        return state

    def save_world_state(self, state: dict):
        """保存完整 world_state。"""
        for key, value in state.items():
            self._save_json(self.root / "memory" / "world_state" / f"{key}.json", value)

    def add_pending_change(self, change: dict):
        """添加待提交的状态变更。"""
        pending_file = self.root / "memory" / "world_state" / "pending" / "pending_changes.json"
        data = self._load_json(pending_file)
        data.setdefault("pending_changes", []).append(change)
        self._save_json(pending_file, data)

    def commit_pending_changes(self, changes: list[dict]):
        """提交通过审查的状态变更。"""
        pending_file = self.root / "memory" / "world_state" / "pending" / "pending_changes.json"
        data = self._load_json(pending_file)
        data["pending_changes"] = [
            c for c in data.get("pending_changes", [])
            if c not in changes
        ]
        self._save_json(pending_file, data)

    # ====== Quality Memory ======

    def load_quality_memory(self) -> dict:
        return self._load_json(self.root / "memory" / "quality_memory.json")

    def save_quality_memory(self, data: dict):
        self._save_json(self.root / "memory" / "quality_memory.json", data)

    def refresh_quality_memory(self, window_reviews: list[dict], current_chapter: int):
        """
        滑动窗口审查完成后刷新质量记忆。
        统计 overused_elements 和 well_received_elements。
        使用配置中的 low_score_threshold 判断过度使用。
        """
        qm = self.load_quality_memory()
        low_threshold = self._get_low_threshold()

        # 简化版：从审查结果中提取
        overused = []
        well_received = []

        for review in window_reviews:
            # Extract low-score dimensions as potential overused
            scores = review.get("scores", {})
            for dim, score in scores.items():
                if score < low_threshold:
                    overused.append({
                        "element": dim,
                        "count": 1,
                        "last_chapter": review.get("chapter_num", current_chapter),
                        "expire_after_chapter": current_chapter + 100,
                    })

            # Extract high-score highlights
            praise = review.get("praise", "")
            if praise and len(praise) > 20:
                well_received.append({
                    "element": praise[:50],
                    "example_chapter": review.get("chapter_num", current_chapter),
                    "confidence": 0.7,
                })

        # Deduplicate and merge, applying overuse threshold (4 times in 100 chapters)
        overused_map = {}
        for item in overused:
            key = item["element"]
            if key in overused_map:
                overused_map[key]["count"] += 1
                # Update last_chapter on merge
                if item["last_chapter"] > overused_map[key]["last_chapter"]:
                    overused_map[key]["last_chapter"] = item["last_chapter"]
            else:
                overused_map[key] = item.copy()

        # Only mark as overused if count >= threshold within window
        config_path = self.root.parent / "config" / "quality_thresholds.json"
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                quality_cfg = json.load(f)
            threshold = quality_cfg.get("overuse_count_threshold", 4)
        else:
            threshold = 4

        filtered_overused = [
            item for item in overused_map.values()
            if item["count"] >= threshold
        ]

        qm["overused_elements"] = filtered_overused
        qm["well_received_elements"] = well_received[:20]  # Limit number
        qm["updated_at_chapter"] = current_chapter

        self.save_quality_memory(qm)
        logger.info(f"Quality memory refreshed at chapter {current_chapter}")

    def cleanup_quality_memory(self, current_chapter: int):
        """清理已过期的质量记忆条目。"""
        qm = self.load_quality_memory()
        overused = qm.get("overused_elements", [])
        cleaned = [
            item for item in overused
            if item.get("expire_after_chapter", 0) >= current_chapter
        ]
        qm["overused_elements"] = cleaned
        qm["last_cleanup_chapter"] = current_chapter
        self.save_quality_memory(qm)
        logger.info(f"Cleaned {len(overused) - len(cleaned)} expired quality memory entries")

    # ====== Sliding Window Review ======

    def load_sliding_window_reviews(self) -> list[dict]:
        return self._load_json(self.root / "audit" / "sliding_window_reviews.json").get("reviews", [])

    def save_sliding_window_review(self, review: dict):
        data = self._load_json(self.root / "audit" / "sliding_window_reviews.json")
        data.setdefault("reviews", []).append(review)
        self._save_json(self.root / "audit" / "sliding_window_reviews.json", data)

    def should_trigger_sliding_window(self, chapter_num: int, window_size: int = 50) -> bool:
        """检查是否应触发滑动窗口审查。"""
        return chapter_num > 0 and chapter_num % window_size == 0

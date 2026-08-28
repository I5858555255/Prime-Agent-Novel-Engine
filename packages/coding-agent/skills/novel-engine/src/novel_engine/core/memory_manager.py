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

    def __init__(self, project_root: str | Path = None):
        self.root = Path(project_root or Path(__file__).parent.parent)
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
        # 保留最近30章（原80章，千万字级别需控制内存膨胀）
        data["recent_chapters"] = data["recent_chapters"][-30:]
        self._save_json(recent_file, data)

    def get_recent_summaries(self, chapter_num: int, count: int = 30) -> list[dict]:
        """获取最近 N 章摘要（默认30章，上限）。"""
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

    # Reviewer 使用的英文维度名 → 中文维度名（对应 quality_thresholds.json 权重）
    DIMENSION_NAMES = {
        "plot_consistency": "剧情一致性",
        "character_consistency": "人物一致性",
        "foreshadow_execution": "伏笔执行",
        "style_match": "文风符合度",
        "pacing": "节奏控制",
        "innovation": "创新亮点",
    }
    # 兜底最大分（应从 quality_thresholds.json 读取）
    DIMENSION_MAX_SCORES = {
        "plot_consistency": 25,
        "character_consistency": 20,
        "foreshadow_execution": 20,
        "style_match": 15,
        "pacing": 10,
        "innovation": 10,
    }
    # 维度得分占最大分低于该比例视为该维度表现不足（过度使用）
    OVERUSED_RATIO = 0.6

    def _get_dimension_max_scores(self) -> dict:
        """从 quality_thresholds.json 的 scoring_dimensions 权重读取各维度满分。"""
        config_path = self.root / "config" / "quality_thresholds.json"
        max_scores = dict(self.DIMENSION_MAX_SCORES)
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                for dim in config.get("scoring_dimensions", []):
                    name = dim.get("name", "")
                    weight = dim.get("weight", 0)
                    for key, cn_name in self.DIMENSION_NAMES.items():
                        if cn_name == name:
                            max_scores[key] = weight
                            break
            except (json.JSONDecodeError, ValueError):
                pass
        return max_scores

    def load_quality_memory(self) -> dict:
        return self._load_json(self.root / "memory" / "quality_memory.json")

    def save_quality_memory(self, data: dict):
        self._save_json(self.root / "memory" / "quality_memory.json", data)

    def refresh_quality_memory(self, window_reviews: list[dict], current_chapter: int):
        """
        滑动窗口审查完成后刷新质量记忆。
        统计 overused_elements 和 well_received_elements。
        按维度归一化判定：维度得分 / 维度满分 < 阈值比例 才标记为过度使用。
        """
        qm = self.load_quality_memory()
        max_scores = self._get_dimension_max_scores()

        # 简化版：从审查结果中提取
        overused = []
        well_received = []

        for review in window_reviews:
            # Extract low-score dimensions as potential overused
            scores = review.get("scores", {})
            for dim, score in scores.items():
                dim_max = max_scores.get(dim, 25)
                if dim_max and score < dim_max * self.OVERUSED_RATIO:
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

        # 从 runtime_config.json 读取 overuse_count_threshold
        config_path = self.root / "config" / "runtime_config.json"
        threshold = 4
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    runtime_cfg = json.load(f)
                threshold = runtime_cfg.get("quality", {}).get("overuse_count_threshold", 4)
            except (json.JSONDecodeError, ValueError):
                pass

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

    def prune_sliding_window_reviews(self, max_windows: int = 3, window_size: int = 50):
        reviews = self.load_sliding_window_reviews()
        max_entries = max_windows * window_size
        if len(reviews) <= max_entries:
            return 0
        pruned = len(reviews) - max_entries
        pruned_reviews = reviews[-max_entries:]
        data = self._load_json(self.root / "audit" / "sliding_window_reviews.json")
        data["reviews"] = pruned_reviews
        self._save_json(self.root / "audit" / "sliding_window_reviews.json", data)
        logger.info(f"Pruned {pruned} sliding window reviews, kept {len(pruned_reviews)}")
        return pruned

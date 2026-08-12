"""
世界模拟器：规则引擎 + 剧情约束校验。
在章节生成前预计算该章的世界状态变化。
"""
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class WorldSimulator:
    """世界模拟器：根据规则和约束计算章节级别的world_state变更。"""

    def __init__(self, project_root: str | Path = "小说工程"):
        self.root = Path(project_root)
        self.rules = self._load_json(self.root / "simulation" / "rules.json")
        self.constraints = self._load_json(self.root / "simulation" / "constraints.json")
        self.characters = self._load_json(self.root / "memory" / "world_state" / "characters.json")
        self.factions = self._load_json(self.root / "memory" / "world_state" / "factions.json")
        self.power_system = self._load_json(self.root / "memory" / "world_state" / "power_system.json")

    def _load_json(self, path: Path) -> dict:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def check_realm_lock(self, character_id: str, current_chapter: int) -> Optional[dict]:
        """
        检查角色境界锁定。
        若存在锁定且当前章节未到 locked_until_chapter，返回锁定信息（阻止自动突破）。
        """
        constraint = self.constraints.get(character_id)
        if not constraint:
            return None

        realm_lock = constraint.get("realm_lock")
        if not realm_lock:
            return None

        locked_until = realm_lock.get("locked_until_chapter", 0)
        if current_chapter < locked_until:
            logger.debug(f"Realm lock active: {character_id} locked until chapter {locked_until}")
            return realm_lock

        return None

    def check_plot_lock(self, character_id: str, current_chapter: int) -> Optional[dict]:
        """检查剧情锁定（如首次出场、身份揭露等）。"""
        constraint = self.constraints.get(character_id)
        if not constraint:
            return None

        plot_lock = constraint.get("plot_lock")
        if not plot_lock:
            return None

        return plot_lock

    def simulate_character_progression(self, character_id: str, current_chapter: int) -> dict:
        """
        模拟角色境界推进。
        先检查锁定，再根据 rules 计算是否应该突破。
        注意：这是辅助参考，实际突破由 chapter_director 根据剧情需要决定。
        """
        lock = self.check_realm_lock(character_id, current_chapter)
        if lock:
            return {
                "character_id": character_id,
                "realm": lock["current"],
                "locked": True,
                "reason": lock.get("reason", ""),
            }

        char_data = self.characters.get("characters", {}).get(character_id, {})
        current_realm = char_data.get("realm", "未知")

        # 简化版：根据角色当前境界和章节位置给出建议
        base_rates = self.rules.get("realm_progression", {}).get("base_rates", {})
        suggestion = {
            "character_id": character_id,
            "current_realm": current_realm,
            "locked": False,
            "suggestion": "保持当前境界，等待剧情节点",
        }

        return suggestion

    def simulate_faction_changes(self, current_chapter: int) -> dict:
        """模拟势力变化。"""
        faction_rules = self.rules.get("faction_expansion", {})
        changes = {}

        for faction_name, growth_rate in faction_rules.get("base_growth_per_100_chapters", {}).items():
            # 每100章增长一次
            cycle = current_chapter // 100
            if cycle > 0:
                changes[faction_name] = {
                    "growth_factor": growth_rate * min(cycle, 10),
                    "note": f"基于{cycle}个周期计算"
                }

        return changes

    def build_world_state_for_chapter(self, chapter_num: int) -> dict:
        """
        构建指定章节的世界状态快照。
        包含所有角色的当前状态、势力状态、时间线事件。
        """
        state = {
            "chapter": chapter_num,
            "timestamp": None,
            "characters": {},
            "factions": {},
            "power_balance": {},
            "constraints_active": [],
        }

        # 角色状态
        for char_id, char_data in self.characters.get("characters", {}).items():
            progression = self.simulate_character_progression(char_id, chapter_num)
            plot_lock_info = self.check_plot_lock(char_id, chapter_num)

            entry = {
                **char_data,
                "progression_suggestion": progression,
            }
            if plot_lock_info:
                entry["plot_lock"] = plot_lock_info

            state["characters"][char_id] = entry

            # 记录活跃约束
            if progression.get("locked"):
                state["constraints_active"].append({
                    "type": "realm_lock",
                    "character_id": char_id,
                    "detail": progression,
                })

        # 势力状态
        state["factions"] = self.factions.get("factions", {})

        # 力量平衡
        state["power_balance"] = self.power_system.get("current_power_balance", {})

        return state

    def apply_pending_changes(self, pending_changes: list[dict]) -> bool:
        """
        将审查通过的状态变更应用到 world_state。
        pending_changes 来自缩写生成的状态变更提案。
        """
        modified = False

        for change in pending_changes:
            change_type = change.get("type")
            target = change.get("target")

            if change_type == "character_realm" and target in self.characters.get("characters", {}):
                self.characters["characters"][target]["realm"] = change.get("new_value")
                modified = True
                logger.info(f"Applied realm change: {target} → {change.get('new_value')}")

            elif change_type == "character_location" and target in self.characters.get("characters", {}):
                self.characters["characters"][target]["location"] = change.get("new_value")
                modified = True

            elif change_type == "relationship_update":
                rel_id = change.get("relationship_id")
                if rel_id:
                    self.characters.setdefault("characters", {}).setdefault(
                        rel_id.split("-")[0], {}
                    )["relationships"][rel_id.split("-")[1]] = change.get("new_value")
                    modified = True

            elif change_type == "timeline_event":
                event = {
                    "chapter": change.get("chapter"),
                    "event": change.get("event"),
                    "characters": change.get("characters", []),
                }
                self.power_system.setdefault("breakthrough_history", []).append(event)
                modified = True

        if modified:
            self._save_characters()
            self._save_power_system()

        return modified

    def _save_characters(self):
        path = self.root / "memory" / "world_state" / "characters.json"
        path.write_text(json.dumps(self.characters, ensure_ascii=False, indent=2), encoding="utf-8")

    def _save_power_system(self):
        path = self.root / "memory" / "world_state" / "power_system.json"
        path.write_text(json.dumps(self.power_system, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_constraints_summary(self, chapter_num: int) -> str:
        """生成当前章节的约束摘要文本，供 director 使用。"""
        lines = []
        for char_id in self.constraints:
            lock = self.check_realm_lock(char_id, chapter_num)
            if lock:
                name = lock.get("name", char_id)
                lines.append(f"- {name}({char_id}): 境界锁定为 {lock['current']}，直到第{lock['locked_until_chapter']}章")

            plot_lock = self.check_plot_lock(char_id, chapter_num)
            if plot_lock:
                lines.append(f"- {char_id}: 剧情锁定 - {json.dumps(plot_lock, ensure_ascii=False)}")

        return "\n".join(lines) if lines else "无活跃约束"

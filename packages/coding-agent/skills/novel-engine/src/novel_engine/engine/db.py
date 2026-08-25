"""
StateDB: 实现千万字长卷小说下的代码化、确定性状态精确查询，彻底解决向量检索（RAG）的时序与事实混淆缺陷。
"""
import sqlite3
import json
import logging
from pathlib import Path
from typing import Optional, Any, List

logger = logging.getLogger(__name__)


class StateDB:
    """状态数据库：将 JSON 世界观规约模型编译为 SQLite 表，并提供确定性 SQL/DSL 接口。"""

    def __init__(self, db_path: str = ":memory:", project_root: str | Path = None):
        self.root = Path(project_root or Path(__file__).parent.parent)
        self.conn = sqlite3.connect(db_path, timeout=30.0)
        self.conn.row_factory = sqlite3.Row
        # 启用 WAL 模式 + busy_timeout，避免多连接下 Windows 文件锁导致的 "database is locked"
        if db_path != ":memory:":
            try:
                self.conn.execute("PRAGMA journal_mode=WAL")
                self.conn.execute("PRAGMA busy_timeout=30000")
                self.conn.execute("PRAGMA synchronous=NORMAL")
            except Exception as e:
                logger.warning(f"Failed to set SQLite PRAGMA: {e}")
        self._init_tables()
        self.import_from_json()

    def _init_tables(self):
        """初始化表结构，支持角色、势力、物品、伏笔等关系型持久化。"""
        cursor = self.conn.cursor()

        # 1. 角色表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                realm TEXT,
                location TEXT,
                description TEXT,
                faction_id TEXT
            )
        """)

        # 2. 势力表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS factions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                leader TEXT,
                description TEXT,
                power_level INTEGER DEFAULT 100
            )
        """)

        # 3. 伏笔表 (含 clue_plan 的结构化提取)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS foreshadows (
                id TEXT PRIMARY KEY,
                plant_chapter INTEGER,
                resolve_chapter INTEGER,
                plant_context TEXT,
                resolve_method TEXT,
                importance REAL DEFAULT 0.5,
                status TEXT DEFAULT 'planned'
            )
        """)

        # 4. 伏笔线索动作表 (与伏笔一对多，定性线索计划)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS clue_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                foreshadow_id TEXT,
                chapter INTEGER,
                intensity TEXT,
                method TEXT,
                FOREIGN KEY (foreshadow_id) REFERENCES foreshadows(id)
            )
        """)

        # 5. 人物关系矩阵表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS relationships (
                char_from TEXT,
                char_to TEXT,
                relation_type TEXT,
                affinity INTEGER,
                description TEXT,
                PRIMARY KEY (char_from, char_to)
            )
        """)

        self.conn.commit()

    def import_from_json(self):
        """从项目现有的 world_state JSON 文件及 foreshadows 中加载事实。"""
        cursor = self.conn.cursor()

        # 导入角色
        char_path = self.root / "memory" / "world_state" / "characters.json"
        if char_path.exists():
            try:
                data = json.loads(char_path.read_text(encoding="utf-8"))
                for cid, cdata in data.get("characters", {}).items():
                    cursor.execute("""
                        INSERT OR REPLACE INTO characters (id, name, realm, location, description, faction_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                    """, (cid, cdata.get("name", ""), cdata.get("realm", ""),
                           cdata.get("location", ""), cdata.get("description", ""), cdata.get("faction_id", "")))
            except Exception as e:
                logger.error(f"Import characters failed: {e}")

        # 导入势力
        faction_path = self.root / "memory" / "world_state" / "factions.json"
        if faction_path.exists():
            try:
                data = json.loads(faction_path.read_text(encoding="utf-8"))
                for fid, fdata in data.get("factions", {}).items():
                    cursor.execute("""
                        INSERT OR REPLACE INTO factions (id, name, leader, description, power_level)
                        VALUES (?, ?, ?, ?, ?)
                    """, (fid, fdata.get("name", ""), fdata.get("leader", ""),
                           fdata.get("description", ""), fdata.get("power_level", 100)))
            except Exception as e:
                logger.error(f"Import factions failed: {e}")

        # 导入伏笔与 Clue Plans
        foreshadow_path = self.root / "foreshadow" / "registry.json"
        if foreshadow_path.exists():
            try:
                data = json.loads(foreshadow_path.read_text(encoding="utf-8"))
                # 先清空再写入，保证幂等，避免跨运行累积膨胀
                cursor.execute("DELETE FROM clue_plans")
                for fs in data.get("foreshadows", []):
                    fs_id = fs.get("id")
                    cursor.execute("""
                        INSERT OR REPLACE INTO foreshadows (id, plant_chapter, resolve_chapter, plant_context, resolve_method, importance, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (fs_id, fs.get("plant_chapter", 0), fs.get("resolve_chapter", 3000),
                           fs.get("plant_context", ""), fs.get("resolve_method", ""),
                           fs.get("importance", 0.5), fs.get("status", "planned")))

                    # 导入线索动作计划
                    for plan in fs.get("clue_plan", []):
                        cursor.execute("""
                            INSERT INTO clue_plans (foreshadow_id, chapter, intensity, method)
                            VALUES (?, ?, ?, ?)
                        """, (fs_id, plan.get("chapter", 0), plan.get("intensity", ""), plan.get("method", "")))
            except Exception as e:
                logger.error(f"Import foreshadows failed: {e}")

        # 导入人物关系
        rel_path = self.root / "memory" / "world_state" / "relationships.json"
        if rel_path.exists():
            try:
                rel_data = json.loads(rel_path.read_text(encoding="utf-8"))
                for rel in rel_data.get("relationships", []):
                    cursor.execute("""
                        INSERT OR REPLACE INTO relationships (char_from, char_to, relation_type, affinity, description)
                        VALUES (?, ?, ?, ?, ?)
                    """, (
                        rel.get("char_from", ""),
                        rel.get("char_to", ""),
                        rel.get("relation_type", ""),
                        rel.get("affinity", 50),
                        rel.get("trigger", ""),
                    ))
            except Exception as e:
                logger.error(f"Import relationships failed: {e}")

        self.conn.commit()

    # ====== 确定性精确状态查询 API ======

    def get_character_realm(self, character_id: str) -> str:
        """纯代码硬逻辑，100% 精确查询角色当前境界，杜绝 RAG 漂移。"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT realm FROM characters WHERE id = ?", (character_id,))
        row = cursor.fetchone()
        return row["realm"] if row else "未知"

    def is_character_alive(self, character_id: str) -> bool:
        """检查角色生存状态。"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT realm FROM characters WHERE id = ?", (character_id,))
        row = cursor.fetchone()
        if not row:
            return False
        return "陨落" not in str(row["realm"]) and "死亡" not in str(row["realm"])

    def query_active_foreshadows(self, current_chapter: int) -> list[dict]:
        """
        根据章节号进行时序过滤，找出在当前章节应该埋设或回收的所有伏笔线索计划。
        这是解决“时序错乱、伏笔泄露”的确定性方案。
        """
        cursor = self.conn.cursor()
        cursor.execute("""
            SELECT f.id, f.plant_context, f.resolve_method, cp.intensity, cp.method
            FROM foreshadows f
            JOIN clue_plans cp ON f.id = cp.foreshadow_id
            WHERE cp.chapter = ? AND f.status = 'planned'
        """, (current_chapter,))

        rows = cursor.fetchall()
        return [dict(r) for r in rows]

    def execute_custom_query(self, sql: str, params: tuple = ()) -> list[dict]:
        """支持 Agent 在运行中动态编写和运行 SQL 逻辑。"""
        cursor = self.conn.cursor()
        try:
            cursor.execute(sql, params)
            return [dict(r) for r in cursor.fetchall()]
        except Exception as e:
            logger.error(f"SQL execution failed: {e}")
            return []

    def close(self):
        self.conn.close()

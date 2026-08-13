"""
测试与验证 Novel-Engine 核心功能：确保 SQL 精确状态检索、Session 树分支与回滚、增量缝合 Patcher 全部运行完美！
"""
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from db import StateDB
from session import SessionTree
from patcher import IncrementalPatcher
from subagent import RecursiveSubagent, Subtask


class TestNovelEngine(unittest.TestCase):

    def test_state_db(self):
        """测试代码化确定性精确查询。"""
        db = StateDB(db_path=":memory:")

        # 确保有测试数据，做自包含种子填充
        cursor = db.conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO characters (id, name, realm, location) VALUES ('C001', '韩玄', '炼气三层', '雾隐村')")
        cursor.execute("INSERT OR REPLACE INTO foreshadows (id, status) VALUES ('F001', 'planned')")
        cursor.execute("INSERT OR REPLACE INTO clue_plans (foreshadow_id, chapter, intensity, method) VALUES ('F001', 120, '隐晦提示', '古玉异动')")
        db.conn.commit()

        # 验证 C001 角色
        realm = db.get_character_realm("C001")
        self.assertEqual(realm, "炼气三层")
        self.assertTrue(db.is_character_alive("C001"))

        # 验证时序过滤伏笔线索动作
        active_fs = db.query_active_foreshadows(120)
        self.assertEqual(len(active_fs), 1)
        self.assertEqual(active_fs[0]["method"], "古玉异动")
        db.close()

    def test_session_tree(self):
        """测试 Durable Sessions 的会话分支与级联回退。"""
        tree = SessionTree()
        # 1. 提交初始 Chapter 1 快照
        root_node = tree.add_commit(1, "hash_ch_1", {"characters": {"C001": {"realm": "炼气一层"}}}, score=90)
        self.assertEqual(root_node.chapter_num, 1)

        # 2. 从 Chapter 1 分叉出两个实验分支
        tree.fork_branch("main", "branch_a_harmony")
        tree.fork_branch("main", "branch_b_fight")

        # 提交分支 A 的 Chapter 2 快照
        tree.add_commit(2, "hash_ch_2_a", {"characters": {"C001": {"realm": "炼气二层"}}}, score=95, branch_name="branch_a_harmony")
        # 提交分支 B 的 Chapter 2 快照
        tree.add_commit(2, "hash_ch_2_b", {"characters": {"C001": {"realm": "炼气三层"}}}, score=50, branch_name="branch_b_fight")

        # 3. 验证分支独立性
        history_a = tree.get_branch_history("branch_a_harmony")
        self.assertEqual(len(history_a), 2)
        self.assertEqual(history_a[-1].world_state_snapshot["characters"]["C001"]["realm"], "炼气二层")

        history_b = tree.get_branch_history("branch_b_fight")
        self.assertEqual(len(history_b), 2)
        self.assertEqual(history_b[-1].world_state_snapshot["characters"]["C001"]["realm"], "炼气三层")

        # 4. 因分支 B 评分过低（50分），执行级联回滚
        rolled_snapshot = tree.rollback_to_node(root_node.node_id, branch_name="branch_b_fight")
        self.assertEqual(rolled_snapshot["characters"]["C001"]["realm"], "炼气一层")

    def test_incremental_patcher(self):
        """测试高阶增量自修复与缝合。"""
        full_text = (
            "【场景1：东荒村落】\n韩玄在东荒村落醒来，抚摸红色的旧玉佩。\n\n※\n\n"
            "【场景2：藏经阁】\n韩玄在藏经阁翻阅古籍，汗水顺着脖子流下。"
        )

        # 1. 提取特定场景文本进行分析
        scene_1 = IncrementalPatcher.extract_scene(full_text, 1)
        self.assertIn("东荒村落", scene_1)

        # 2. 精确局部缝合 (不重写其他场景)
        patched_scene_1 = "【场景1：东荒村落】\n韩玄在东荒村落醒来，抚摸古玉，古玉放出微微玄光。"
        updated_full_text = IncrementalPatcher.apply_scene_patch(full_text, 1, patched_scene_1)

        self.assertIn("古玉放出微微玄光", updated_full_text)
        self.assertIn("韩玄在藏经阁翻阅古籍", updated_full_text)  # 保证场景2完好无损！

    def test_recursive_subagent(self):
        """测试递归子 Agent Concurrency。"""
        agent = RecursiveSubagent("director_01", "chapter_director")
        child_agent = agent.spawn_child_agent("scene_polisher")

        self.assertEqual(len(agent.child_agents), 1)
        self.assertEqual(child_agent.role, "scene_polisher")


if __name__ == "__main__":
    unittest.main()

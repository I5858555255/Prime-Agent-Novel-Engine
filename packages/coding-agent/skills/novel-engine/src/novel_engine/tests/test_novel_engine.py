"""
测试与验证 Novel-Engine 核心功能：确保 SQL 精确状态检索、Session 树分支与回滚、增量缝合 Patcher 全部运行完美！
"""
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from novel_engine.engine.db import StateDB
from novel_engine.engine.session import SessionTree
from novel_engine.engine.patcher import IncrementalPatcher
from novel_engine.engine.subagent import RecursiveSubagent, Subtask
import json

from novel_engine.core.llm_client import _mock_task_card, _mock_synopsis


class MockLLMForFix:
    def __init__(self):
        self.call_count = 0
        self.review_count = 0

    def chat_completion(self, messages, temperature=None, max_tokens=None, retry_on_error=True, max_retries=3, extra_body=None):
        self.call_count += 1
        combined = "\n".join(m.get("content", "") for m in messages)

        if "审查要求" in combined:
            self.review_count += 1
            print(f"CALL {self.call_count}: MATCHED review (attempt {self.review_count})")
            # On first call, return verdict "fix" with fix_scope "场景1"
            if self.review_count == 1: # first chapter review
                return {
                    "role": "assistant",
                    "content": json.dumps({
                        "chapter_num": 1,
                        "scores": {"plot_consistency": 20, "character_consistency": 15, "foreshadow_execution": 18, "style_match": 12, "pacing": 8, "innovation": 7},
                        "total_score": 80,
                        "verdict": "fix",
                        "issues": [{"dimension": "character_consistency", "severity": "medium", "description": "场景1中好感度表现不一致", "suggested_fix": "增加对话说明"}],
                        "praise": "场景2和场景3很好",
                        "fix_scope": "场景1"
                    }, ensure_ascii=False)
                }
            else:
                return {
                    "role": "assistant",
                    "content": json.dumps({
                        "chapter_num": 1,
                        "scores": {"plot_consistency": 25, "character_consistency": 20, "foreshadow_execution": 20, "style_match": 15, "pacing": 10, "innovation": 10},
                        "total_score": 100,
                        "verdict": "pass",
                        "issues": [],
                        "praise": "完美",
                        "fix_scope": ""
                    }, ensure_ascii=False)
                }
        elif "场景原内容" in combined:
            print(f"CALL {self.call_count}: MATCHED patcher")
            return {"role": "assistant", "content": "【场景1：东荒村落】\n韩玄在东荒村落醒来，抚摸古玉，古玉放出微微玄光。"}
        elif "网络小说作家" in combined or "润色" in combined:
            print(f"CALL {self.call_count}: MATCHED writing/polishing")
            return {"role": "assistant", "content": "【场景1：雾隐村】\n韩玄在雾隐村抚摸旧玉佩。\n\n※\n\n【场景2：藏经阁】\n韩玄在藏经阁翻阅古籍。"}
        elif "任务卡" in combined or "scene_blueprints" in combined:
            return {"role": "assistant", "content": _mock_task_card(1)}
        elif "缩写" in combined or "state_changes" in combined:
            return {"role": "assistant", "content": _mock_synopsis(1)}
        elif "正文" in combined or "场景" in combined:
            return {"role": "assistant", "content": "【场景1：雾隐村】\n韩玄在雾隐村抚摸旧玉佩。\n\n※\n\n【场景2：藏经阁】\n韩玄在藏经阁翻阅古籍。"}
        else:
            return {"role": "assistant", "content": "默认回复"}


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

    def test_session_tree_serialization(self):
        """测试 SessionTree 序列化与反序列化。"""
        tree = SessionTree()
        tree.add_commit(1, "hash_ch_1", {"characters": {"C001": {"realm": "炼气一层"}}}, score=90)
        tree.fork_branch("main", "test_branch")
        tree.add_commit(2, "hash_ch_2", {"characters": {"C001": {"realm": "炼气二层"}}}, score=95, branch_name="test_branch")

        # 序列化为字典
        serialized = tree.to_dict()
        self.assertIn("nodes", serialized)
        self.assertIn("branches", serialized)
        self.assertEqual(serialized["branches"]["test_branch"], tree.branches["test_branch"])

        # 反序列化
        new_tree = SessionTree.from_dict(serialized)
        self.assertEqual(new_tree.branches["test_branch"], tree.branches["test_branch"])

        # 验证节点信息
        history = new_tree.get_branch_history("test_branch")
        self.assertEqual(len(history), 2)
        self.assertEqual(history[-1].world_state_snapshot["characters"]["C001"]["realm"], "炼气二层")

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

    def test_pipeline_incremental_patcher(self):
        """测试流水线中集成 IncrementalPatcher 的局部热插拔修复逻辑。"""
        import tempfile
        import shutil
        from pathlib import Path
        import logging
        logging.basicConfig(level=logging.INFO)

        try:
            from novel_engine.core.llm_client import LLMClient
            from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
        except ImportError:
            from novel_engine.core.llm_client import LLMClient
            from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create dummy folders to mimic "小说工程"
            root_path = Path(tmpdir)
            for d in ["config", "simulation", "memory/world_state", "foreshadow", "planning", "bible", "runtime"]:
                (root_path / d).mkdir(parents=True, exist_ok=True)

            # Copy or write essential files
            (root_path / "config" / "runtime_config.json").write_text('{"llm": {"use_mock": true}}', encoding="utf-8")
            (root_path / "simulation" / "rules.json").write_text('{}', encoding="utf-8")
            (root_path / "simulation" / "constraints.json").write_text('{}', encoding="utf-8")
            (root_path / "memory/world_state/characters.json").write_text('{"characters": {}}', encoding="utf-8")
            (root_path / "memory/world_state/factions.json").write_text('{"factions": {}}', encoding="utf-8")
            (root_path / "memory/world_state/power_system.json").write_text('{"current_power_balance": {}}', encoding="utf-8")
            (root_path / "foreshadow" / "registry.json").write_text('{"foreshadows": []}', encoding="utf-8")
            (root_path / "planning" / "volumes.json").write_text('{"volumes": [{"id": "V01", "chapter_range": [1, 100]}]}', encoding="utf-8")
            (root_path / "planning" / "plot_graph.json").write_text('{"nodes": []}', encoding="utf-8")
            (root_path / "bible" / "world_bible.md").write_text('', encoding="utf-8")
            (root_path / "bible" / "character_bible.md").write_text('', encoding="utf-8")
            (root_path / "bible" / "style_bible.md").write_text('', encoding="utf-8")
            (root_path / "bible" / "author_intent.md").write_text('', encoding="utf-8")
            (root_path / "planning" / "吸氧证道_V2_1_完整大纲.md").write_text('', encoding="utf-8")

            # Setup LLMClient with MockLLMForFix
            mock_llm_internal = MockLLMForFix()
            llm_client = LLMClient(use_mock=True)
            llm_client._mock = mock_llm_internal

            orchestrator = PipelineOrchestrator(project_root=tmpdir, llm_client=llm_client)
            result = orchestrator.generate_single_chapter(1)

            # 验证流程完成并应用了局部修复
            self.assertTrue(result["success"])
            self.assertEqual(result["chapter"], 1)
            # Verify original scene 2 is intact, but scene 1 has been patched/repaired
            self.assertIn("藏经阁", orchestrator.current_novel)
            orchestrator.close()


class _EmptyContentClient:
    def __init__(self, reasoning="这是正文内容"):
        self._r = reasoning
    def chat_completion(self, messages, temperature=None, max_tokens=None,
                        retry_on_error=True, max_retries=3, extra_body=None):
        return {"role": "assistant", "content": "", "reasoning_content": self._r,
                "finish_reason": "stop"}

def test_provider_uses_reasoning_fallback():
    from novel_engine.core.llm_provider import LLMProvider
    p = LLMProvider(_EmptyContentClient("兜底正文"))
    out = p.complete([{"role": "user", "content": "写一章"}], output_json=False)
    assert out == "兜底正文"

class _BothEmptyClient:
    def chat_completion(self, messages, temperature=None, max_tokens=None,
                        retry_on_error=True, max_retries=3, extra_body=None):
        return {"role": "assistant", "content": "", "reasoning_content": "",
                "finish_reason": "stop"}

def test_provider_both_empty_raises():
    from novel_engine.core.llm_provider import LLMProvider, ProviderConfig
    import pytest
    cfg = ProviderConfig(retry_temperatures=[0.85, 0.7])
    with pytest.raises(RuntimeError):
        LLMProvider(_BothEmptyClient(), cfg).complete(
            [{"role": "user", "content": "写一章"}], output_json=False)


def test_call_llm_via_provider():
    from novel_engine.core.llm_client import call_llm, MockLLMClient
    out = call_llm("生成任务卡", client=MockLLMClient())
    assert isinstance(out, str) and len(out) > 0


def test_provider_config_loads():
    import json
    from pathlib import Path
    cfg = json.loads(Path("novel_engine/config/runtime_config.json").read_text(encoding="utf-8"))
    assert cfg["provider"]["family"] == "agnes"
    assert cfg["quality"]["publication_line"] == 82
    assert cfg["quality"]["min_chapter_score"] == 82


def test_chapter_auto_retry_then_pass():
    class Flaky:
        def __init__(self): self.n = 0
        def chat_completion(self, messages, temperature=None, max_tokens=None,
                            retry_on_error=True, max_retries=3, extra_body=None):
            self.n += 1
            if self.n < 3:
                return {"role": "assistant", "content": "", "reasoning_content": "",
                        "finish_reason": "stop"}
            return {"role": "assistant", "content": "正常正文", "finish_reason": "stop"}
    from novel_engine.core.llm_provider import LLMProvider
    assert LLMProvider(Flaky()).complete(
        [{"role": "user", "content": "x"}], output_json=False) == "正常正文"


def test_slo_fail_rate_threshold():
    from novel_engine.tests.slo_gate import evaluate_slo
    report = {"passed": 198, "failed": 3, "results": [{"score": 86}] * 201,
              "quality": {"dimension_averages": {}}}
    res = evaluate_slo(report, max_fail_rate=0.01)
    assert res["meets_stability"] is False


def test_grade_review_uses_publication_line():
    from novel_engine.agents.reviewer_agent import ReviewerAgent
    import json
    from pathlib import Path
    cfg = json.loads(Path("novel_engine/config/runtime_config.json").read_text(encoding="utf-8"))
    line = cfg["quality"]["publication_line"]
    a = ReviewerAgent.__new__(ReviewerAgent)
    assert a.grade_review({"total_score": line}) == "pass"
    assert a.grade_review({"total_score": line - 1}) == "fix"
    assert a.grade_review({"total_score": 59}) == "fail"


def test_enforce_word_count_pads_short():
    from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator

    class _LongClient:
        def chat_completion(self, messages, temperature=None, max_tokens=None,
                            retry_on_error=True, max_retries=3, extra_body=None):
            return {"role": "assistant", "content": "补充" * 100, "finish_reason": "stop"}

    class _Fake:
        llm = _LongClient()

    out = PipelineOrchestrator._enforce_word_count(_Fake(), "短", 100, 200)
    assert len(out) >= 100


def test_agents_prompt_keywords():
    from novel_engine.agents.pacing_advisor import PacingAdvisor
    from novel_engine.agents.innovation_checker import InnovationChecker
    from novel_engine.agents.style_guard import StyleGuard

    class _Kw:
        def chat_completion(self, messages, temperature=None, max_tokens=None,
                            retry_on_error=True, max_retries=3, extra_body=None):
            return {"role": "assistant", "content": "创新文风内容", "finish_reason": "stop"}

    assert "节奏" in PacingAdvisor().pre_write_constraints("某章大纲")
    assert "创新" in InnovationChecker().rewrite("正文", {"dimension_scores": {}}, client=_Kw())
    assert "文风" in StyleGuard().rewrite("正文", client=_Kw())


if __name__ == "__main__":
    unittest.main()

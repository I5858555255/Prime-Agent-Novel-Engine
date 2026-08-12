"""
流水线编排器：将所有章节生成 Agent 串联起来。
负责：
1. 状态机状态管理
2. Agent 调用顺序
3. 失败重试与恢复
4. 数据传递
"""
import json
import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from state_machine import StateMachine, ChapterPhase
from checkpoint import CheckpointManager
from world_simulator import WorldSimulator
from chapter_director import ChapterDirector
from writer_agent import SynopsisAgent, WriterAgent
from reviewer_agent import ReviewerAgent
from memory_manager import MemoryManager
from llm_client import LLMClient, call_llm

logger = logging.getLogger(__name__)


class PipelineOrchestrator:
    """章节生成流水线编排器。"""

    def __init__(self, project_root: str | Path = "小说工程", llm_client: Optional[LLMClient] = None):
        self.root = Path(project_root)
        self.llm = llm_client or LLMClient.from_config(self.root / "config" / "runtime_config.json")

        self.state_machine = StateMachine(self.root)
        self.checkpoint_mgr = CheckpointManager(self.root)
        self.simulator = WorldSimulator(self.root)
        self.director = ChapterDirector(self.root, llm_client=self.llm)
        self.synopsis_agent = SynopsisAgent(llm_client=self.llm)
        self.writer = WriterAgent(llm_client=self.llm)
        self.reviewer = ReviewerAgent(llm_client=self.llm)
        self.memory = MemoryManager(self.root)

        # 存储当前章节的产出，供 commit 使用
        self.current_novel = ""
        self.current_synopsis = {}
        self.current_outline = {}
        # Cost tracking
        from llm_client import get_call_log, reset_call_log
        self._call_log = get_call_log
        self._reset_call_log = reset_call_log
        self.cost_tracker = {
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_reasoning_tokens": 0,
            "total_tokens": 0,
            "api_calls": 0,
            "per_chapter_costs": {},
            "sliding_window_constraint_adjustments": 0,
        }
        # Pre-compute director's fixed context (bible + volumes + plot_graph) — loaded once at init
        self._director_fixed_context = self._load_director_fixed_context()

    def _load_director_fixed_context(self) -> dict:
        """一次性加载固定上下文，避免每章重复 I/O。"""
        def _load_json(path: Path) -> dict:
            if path.exists():
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        return json.load(f)
                except (json.JSONDecodeError, ValueError):
                    return {}
            return {}

        volumes = _load_json(self.root / "planning" / "volumes.json")
        plot_graph = _load_json(self.root / "planning" / "plot_graph.json")
        foreshadow_registry = _load_json(self.root / "foreshadow" / "registry.json")

        return {
            "volumes": volumes,
            "plot_graph": plot_graph,
            "foreshadow_registry": foreshadow_registry,
        }

    def generate_single_chapter(self, chapter_num: int) -> dict:
        """
        生成单章的完整流水线。
        返回结果字典。
        """
        result = {
            "chapter": chapter_num,
            "success": False,
            "score": None,
            "errors": [],
        }

        logger.info(f"=== Starting chapter {chapter_num} ===")
        sm = self.state_machine
        sm.current_chapter = chapter_num
        sm.current_phase = ChapterPhase.INIT
        sm.retry_count = 0

        # 阶段0：规划
        try:
            sm.transition(ChapterPhase.PLANNING)
        except Exception as e:
            result["errors"].append(f"PLANNING: {e}")
            sm.handle_failure("planning_error", str(e))
            return result

        # 阶段1：世界模拟器预计算
        try:
            sm.transition(ChapterPhase.WORLD_SIM)
            world_state = self.simulator.build_world_state_for_chapter(chapter_num)
            self.current_world_state = world_state
            logger.info(f"World simulation done for chapter {chapter_num}")
        except Exception as e:
            result["errors"].append(f"WORLD_SIM: {e}")
            sm.handle_failure("world_sim_error", str(e))
            return result

        # 阶段2：章节导演生成任务卡（使用预计算的固定上下文）
        try:
            sm.transition(ChapterPhase.DIRECTING)
            task_card = self.director.generate_task_card_cached(
                chapter_num, self._director_fixed_context
            )

            # 验证任务卡
            errors = self.director.validate_task_card(task_card, chapter_num)
            if errors:
                raise ValueError(f"Task card validation failed: {errors}")

            self.current_outline = task_card
            logger.info(f"Task card generated for chapter {chapter_num}")
        except Exception as e:
            result["errors"].append(f"DIRECTING: {e}")
            sm.handle_failure("directing_error", str(e))
            return result

        # 阶段3：缩写生成
        try:
            sm.transition(ChapterPhase.SYNOPSIS)
            synopsis = self.synopsis_agent.generate_synopsis(task_card)
            self.current_synopsis = synopsis

            # 应用待提交的状态变更到 pending
            for change in synopsis.get("state_changes", []):
                self.memory.add_pending_change(change)

            logger.info(f"Synopsis generated for chapter {chapter_num}")
        except Exception as e:
            result["errors"].append(f"SYNOPSIS: {e}")
            sm.handle_failure("synopsis_error", str(e))
            return result

        # 阶段4：正文生成（场景级）+ 润色
        try:
            sm.transition(ChapterPhase.WRITE_SCENE)
            novel_text = self.writer.generate_full_chapter(task_card, synopsis)
            sm.transition(ChapterPhase.POLISH)
            novel_text = self.writer.polish_chapter(novel_text, task_card)
            self.current_novel = novel_text
            logger.info(f"Novel text generated for chapter {chapter_num} ({len(novel_text)} chars)")
        except Exception as e:
            result["errors"].append(f"WRITE: {e}")
            sm.handle_failure("writing_error", str(e))
            return result

        # 阶段5：审查评分
        try:
            sm.transition(ChapterPhase.REVIEW)
            review = self.reviewer.review_chapter(
                chapter_num=chapter_num,
                task_card=task_card,
                synopsis=synopsis,
                novel_text=novel_text,
                world_state=world_state,
            )
            score = review.get("total_score", 0)
            result["score"] = score
            verdict = self.reviewer.grade_review(review)
            logger.info(f"Chapter {chapter_num} review: score={score}, verdict={verdict}")

            if verdict == "pass":
                result["success"] = True
                logger.info(f"Chapter {chapter_num} PASSED (score={score})")
            elif verdict == "fix":
                # 局部修复：使用审查意见生成针对性修复 prompt
                fix_prompt = self.reviewer.generate_fix_prompt(review, novel_text)
                fixed_text = call_llm(
                    prompt=fix_prompt,
                    system_prompt=self.writer.SCENE_SYSTEM_PROMPT,
                    client=self.writer.llm,
                )
                self.current_novel = fixed_text
                result["errors"].append(f"FIX: score={score}")
            else:
                # 全量回退
                result["errors"].append(f"FAIL: score={score}")
                if sm.can_retry():
                    sm.increment_retry()
                    logger.warning(f"Retrying chapter {chapter_num} (attempt {sm.retry_count})")
                    return self.generate_single_chapter(chapter_num)
                else:
                    sm.handle_failure("review_exhausted", f"Score={score}")
                    return result
        except Exception as e:
            result["errors"].append(f"REVIEW: {e}")
            sm.handle_failure("review_error", str(e))
            return result

        # 保存单章审查结果供滑动窗口质量记忆使用
        review_file = self.root / "audit" / "per_chapter_reviews.json"
        if review_file.exists():
            try:
                existing = json.loads(review_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, ValueError):
                existing = {"reviews": []}
        else:
            existing = {"reviews": []}
        existing["reviews"].append({
            "chapter_num": chapter_num,
            "total_score": score,
            "verdict": verdict,
            "scores": review.get("scores", {}),
            "praise": review.get("praise", ""),
            "issues": review.get("issues", []),
        })
        review_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")

        # 阶段6：提交
        try:
            # 提取关键词用于索引
            keywords = self._extract_keywords(task_card, synopsis)
            self.memory.update_chapter_index(chapter_num, keywords)
            self.memory.add_recent_chapter(chapter_num, {
                "goal": task_card.get("core_goal", ""),
                "summary": synopsis.get("synopsis", ""),
                "word_count": len(self.current_novel),
            })

            # 正式提交状态变更
            pending_changes = synopsis.get("state_changes", [])
            if pending_changes:
                self.simulator.apply_pending_changes(pending_changes)
                self.memory.commit_pending_changes(pending_changes)

            checkpoint = sm.commit_chapter(
                chapter_num=chapter_num,
                novel_content=self.current_novel,
                synopsis_content=json.dumps(synopsis, ensure_ascii=False),
                outline_content=json.dumps(task_card, ensure_ascii=False),
                world_state_snapshot=world_state,
            )

            result["success"] = True
            logger.info(f"Chapter {chapter_num} COMMITTED")
        except Exception as e:
            result["errors"].append(f"COMMIT: {e}")
            sm.handle_failure("commit_error", str(e))
            return result

        # Accumulate cost data for this chapter
        call_log = self._call_log()
        chapter_tokens = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "reasoning_tokens": 0,
            "total_tokens": 0,
            "api_calls": len(call_log),
        }
        for entry in call_log:
            chapter_tokens["prompt_tokens"] += entry.get("prompt_tokens", 0)
            chapter_tokens["completion_tokens"] += entry.get("completion_tokens", 0)
            chapter_tokens["reasoning_tokens"] += entry.get("reasoning_tokens", 0)
            chapter_tokens["total_tokens"] += entry.get("total_tokens", 0)

        self.cost_tracker["per_chapter_costs"][chapter_num] = chapter_tokens
        self.cost_tracker["total_prompt_tokens"] += chapter_tokens["prompt_tokens"]
        self.cost_tracker["total_completion_tokens"] += chapter_tokens["completion_tokens"]
        self.cost_tracker["total_reasoning_tokens"] += chapter_tokens["reasoning_tokens"]
        self.cost_tracker["total_tokens"] += chapter_tokens["total_tokens"]
        self.cost_tracker["api_calls"] += chapter_tokens["api_calls"]

        return result

    def _extract_keywords(self, task_card: dict, synopsis: dict) -> list[str]:
        """从任务卡和缩写中提取关键词。"""
        keywords = []
        keywords.append(task_card.get("core_goal", "")[:30])

        for scene in task_card.get("scene_blueprints", []):
            keywords.extend(scene.get("location", "").split("·")[:2])

        synopsis_text = synopsis.get("synopsis", "")
        # 简单分词：取前20个非空字符段
        words = [w.strip() for w in synopsis_text.replace("，", " ").replace("。", " ").split() if len(w.strip()) > 1][:20]
        keywords.extend(words)

        return list(set(keywords))

    def run_mini_test(self, num_chapters: int = 10) -> list[dict]:
        """运行 Mini 测试：生成 N 章。"""
        results = []
        self.state_machine.current_chapter = 0

        for i in range(1, num_chapters + 1):
            self.state_machine.current_chapter = i
            result = self.generate_single_chapter(i)
            results.append(result)

            if not result["success"]:
                logger.error(f"Mini test FAILED at chapter {i}")
                break

        return results

    def run_medium_test(self, num_chapters: int = 70) -> list[dict]:
        """运行中等规模测试：生成 N 章（含滑动窗口审查）。"""
        results = []

        for i in range(1, num_chapters + 1):
            result = self.generate_single_chapter(i)
            results.append(result)

            # 每50章触发滑动窗口审查
            if self.memory.should_trigger_sliding_window(i, window_size=50):
                logger.info(f"Triggering sliding window review at chapter {i}")
                self._run_sliding_window_review(i)

        return results

    def _run_sliding_window_review(self, current_chapter: int):
        """执行滑动窗口审查。"""
        window_start = current_chapter - 49

        # 读取每章单章审查结果（含评分/亮点/问题）
        review_file = self.root / "audit" / "per_chapter_reviews.json"
        all_reviews = []
        if review_file.exists():
            try:
                all_reviews = json.loads(review_file.read_text(encoding="utf-8")).get("reviews", [])
            except (json.JSONDecodeError, ValueError):
                all_reviews = []

        window_reviews = [r for r in all_reviews if window_start <= r.get("chapter_num", 0) <= current_chapter]

        # 同时收集缩写文本，供节奏/重复/伏笔密度分析
        synopsis_texts = []
        for ch in range(window_start, current_chapter + 1):
            synopsis_path = self.root / "chapters" / "synopsis" / f"chapter_{ch}.txt"
            if synopsis_path.exists():
                synopsis_texts.append({
                    "chapter": ch,
                    "synopsis": synopsis_path.read_text(encoding="utf-8"),
                })

        window_review = {
            "window_start": window_start,
            "window_end": current_chapter,
            "issues": {
                "pacing": [],
                "repetition": [],
                "foreshadow_density": [],
                "character_development": []
            },
            "summary": "滑动窗口审查完成。"
        }

        if window_reviews or synopsis_texts:
            # 调用 LLM 生成评估对象
            prompt = f"""请分析第 {window_start} 到第 {current_chapter} 章的写作情况。
我为你提供这两部分输入：
1. 这 50 章的历史审查反馈（包含评分、亮点、发现的问题等）：
{json.dumps(window_reviews, ensure_ascii=False, indent=2)[:8000]}

2. 这 50 章的章节缩写：
{json.dumps(synopsis_texts, ensure_ascii=False, indent=2)[:8000]}

请从以下四个方面全面评估这 50 章：
- 节奏控制（pacing）：是否存在连续无情节波动的平淡章节？
- 套路重复（repetition）：是否频繁出现相同的剧情套路或战斗情节？
- 伏笔密度（foreshadow_density）：clue_plan 的执行密度是否合理，是否太高或太低？
- 人物成长（character_development）：主角及重要配角是否符合成长曲线？

请输出以下格式的 JSON（注意 issues 字典中的 key 必须完全一致）：
{{
  "window_start": {window_start},
  "window_end": {current_chapter},
  "summary": "50章整体评估概述...",
  "issues": {{
    "pacing": [
      {{
        "description": "节奏过于平淡或紧凑的具体描述",
        "severity": "high|medium|low"
      }}
    ],
    "repetition": [
      {{
        "description": "套路重复的具体描述",
        "severity": "high|medium|low"
      }}
    ],
    "foreshadow_density": [
      {{
        "description": "伏笔执行问题的描述",
        "severity": "high|medium|low"
      }}
    ],
    "character_development": [
      {{
        "description": "人物设定或成长不一致/缓慢的描述",
        "severity": "high|medium|low"
      }}
    ]
  }}
}}"""

            system_prompt = "你是一位资深的网络小说总编辑，擅长进行多章节长线结构和质量审查。"
            try:
                window_review = call_llm(
                    prompt=prompt,
                    system_prompt=system_prompt,
                    client=self.llm,
                    output_json=True
                )
                logger.info(f"Sliding window review generated successfully via LLM for chapters {window_start}-{current_chapter}")
            except Exception as e:
                logger.error(f"Failed to generate sliding window review via LLM: {e}. Falling back to default.")

            # Count constraint adjustments from sliding window issues
            constraint_adjustments = 0
            issues_dict = window_review.get("issues", {})
            for issue_key in ["pacing", "repetition", "foreshadow_density", "character_development"]:
                issues = issues_dict.get(issue_key, [])
                constraint_adjustments += len(issues)

            self.memory.save_sliding_window_review(window_review)

            # Refresh quality memory with real review data
            self.memory.refresh_quality_memory(window_reviews, current_chapter)

            # Clean up expired quality memory entries
            self.memory.cleanup_quality_memory(current_chapter)

            logger.info(f"Sliding window review completed for chapters {window_start}-{current_chapter}")
            logger.info(f"Constraint adjustments from sliding window: {constraint_adjustments}")

        # Track constraint adjustments in cost tracker
        self.cost_tracker["sliding_window_constraint_adjustments"] += constraint_adjustments

    def get_cost_sandbox_report(self, num_chapters: int) -> dict:
        """Generate cost sandbox report from accumulated cost data.

        Returns a report with total token usage, per-chapter averages,
        sliding window constraint adjustments, and cost estimates for full production.
        """
        tracker = self.cost_tracker
        total_calls = tracker["api_calls"]
        total_prompt = tracker["total_prompt_tokens"]
        total_completion = tracker["total_completion_tokens"]
        total_reasoning = tracker["total_reasoning_tokens"]
        total_all = tracker["total_tokens"]

        avg_prompt = total_prompt // num_chapters if num_chapters else 0
        avg_completion = total_completion // num_chapters if num_chapters else 0
        avg_reasoning = total_reasoning // num_chapters if num_chapters else 0
        avg_total = total_all // num_chapters if num_chapters else 0
        avg_calls = total_calls / num_chapters if num_chapters else 0

        production_chapters = 3000
        est_prompt = avg_prompt * production_chapters
        est_completion = avg_completion * production_chapters
        est_reasoning = avg_reasoning * production_chapters
        est_total = avg_total * production_chapters
        est_calls = avg_calls * production_chapters

        sandbox_cfg_path = self.root / "config" / "cost_sandbox.json"
        pricing = {"input_per_1k": 0.0001, "output_per_1k": 0.0002}
        if sandbox_cfg_path.exists():
            try:
                sandbox_cfg = json.loads(sandbox_cfg_path.read_text(encoding="utf-8"))
                p = sandbox_cfg.get("currency_conversion", {}).get("api_pricing", {})
                pricing["input_per_1k"] = p.get("input_per_1k", 0.0001)
                pricing["output_per_1k"] = p.get("output_per_1k", 0.0002)
            except (json.JSONDecodeError, ValueError):
                pass

        input_tokens = total_prompt + total_reasoning
        output_tokens = total_completion
        actual_cost_usd = (input_tokens / 1000 * pricing["input_per_1k"]) + \
                          (output_tokens / 1000 * pricing["output_per_1k"])

        est_production_input = est_prompt + est_reasoning
        est_production_output = est_completion
        est_production_cost_usd = (est_production_input / 1000 * pricing["input_per_1k"]) + \
                                   (est_production_output / 1000 * pricing["output_per_1k"])

        budget_cfg_path = self.root / "config" / "cost_sandbox.json"
        budget = {"total": 500.0, "full_production_max": 400.0}
        if budget_cfg_path.exists():
            try:
                bc = json.loads(budget_cfg_path.read_text(encoding="utf-8"))
                b = bc.get("budget", {})
                budget["total"] = b.get("total", 500.0)
                budget["full_production_max"] = b.get("full_production_max", 400.0)
            except (json.JSONDecodeError, ValueError):
                pass

        budget_pct = (actual_cost_usd / budget["total"] * 100) if budget["total"] else 0
        production_budget_pct = (est_production_cost_usd / budget["full_production_max"] * 100) if budget["full_production_max"] else 0

        sw_adjustments = tracker.get("sliding_window_constraint_adjustments", 0)

        return {
            "test_type": "cost_sandbox",
            "num_chapters_tested": num_chapters,
            "total_api_calls": total_calls,
            "avg_calls_per_chapter": round(avg_calls, 2),
            "token_usage": {
                "total_prompt_tokens": total_prompt,
                "total_completion_tokens": total_completion,
                "total_reasoning_tokens": total_reasoning,
                "total_tokens": total_all,
                "avg_prompt_per_chapter": avg_prompt,
                "avg_completion_per_chapter": avg_completion,
                "avg_reasoning_per_chapter": avg_reasoning,
                "avg_total_per_chapter": avg_total,
            },
            "cost_usd": {
                "sandbox_test_actual": round(actual_cost_usd, 6),
                "estimated_full_production": round(est_production_cost_usd, 2),
                "pricing_input_per_1k": pricing["input_per_1k"],
                "pricing_output_per_1k": pricing["output_per_1k"],
            },
            "budget": {
                "total_budget_usd": budget["total"],
                "full_production_max_usd": budget["full_production_max"],
                "sandbox_test_budget_pct": round(budget_pct, 4),
                "production_budget_pct": round(production_budget_pct, 2),
                "within_budget": est_production_cost_usd <= budget["full_production_max"],
            },
            "sliding_window": {
                "constraint_adjustment_count": sw_adjustments,
                "adjustments_per_50_chapters": sw_adjustments,
            },
            "per_chapter_token_breakdown": tracker.get("per_chapter_costs", {}),
        }

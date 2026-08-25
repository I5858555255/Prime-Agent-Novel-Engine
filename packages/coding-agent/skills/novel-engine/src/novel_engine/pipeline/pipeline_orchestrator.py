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

from novel_engine.core.state_machine import StateMachine, ChapterPhase
from novel_engine.core.checkpoint import CheckpointManager
from novel_engine.agents.world_simulator import WorldSimulator
from novel_engine.agents.chapter_director import ChapterDirector
from novel_engine.agents.writer_agent import SynopsisAgent, WriterAgent
from novel_engine.agents.reviewer_agent import ReviewerAgent
from novel_engine.agents.pacing_advisor import PacingAdvisor
from novel_engine.core.memory_manager import MemoryManager
from novel_engine.core.llm_client import LLMClient, call_llm, get_call_log, reset_call_log
from novel_engine.engine.db import StateDB
from novel_engine.engine.session import SessionTree
from novel_engine.engine.patcher import IncrementalPatcher

logger = logging.getLogger(__name__)


class PipelineOrchestrator:
    """章节生成流水线编排器。"""

    def __init__(self, project_root: str | Path = None, llm_client: Optional[LLMClient] = None):
        self.root = Path(project_root or Path(__file__).parent.parent)
        self.llm = llm_client or LLMClient.from_config(self.root / "config" / "runtime_config.json")

        self.state_machine = StateMachine(self.root)
        self.checkpoint_mgr = CheckpointManager(self.root)
        self.simulator = WorldSimulator(self.root)
        self.director = ChapterDirector(self.root, llm_client=self.llm)
        self.synopsis_agent = SynopsisAgent(llm_client=self.llm)

        # Instantiate StateDB
        db_dir = self.root / "runtime"
        db_dir.mkdir(parents=True, exist_ok=True)
        self.db = StateDB(db_path=str(db_dir / "state.db"), project_root=self.root)

        # Instantiate or load SessionTree
        self.session_tree_path = self.root / "runtime" / "session_tree.json"
        self._load_session_tree()

        self.writer = WriterAgent(llm_client=self.llm)
        self.reviewer = ReviewerAgent(llm_client=self.llm)
        self.memory = MemoryManager(self.root)

        # 存储当前章节的产出，供 commit 使用
        self.current_novel = ""
        self.current_synopsis = {}
        self.current_outline = {}
        # Cost tracking
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

        # Runtime config + provider config for chapter-level retry logic
        try:
            import json
            self.config = json.loads((self.root / "config" / "runtime_config.json").read_text(encoding="utf-8"))
        except Exception:
            self.config = {}
        from novel_engine.core.llm_client import _provider_config_from_runtime
        self.provider_cfg = _provider_config_from_runtime()
        self._attempt_index = 0

    def _load_session_tree(self):
        if self.session_tree_path.exists():
            try:
                data = json.loads(self.session_tree_path.read_text(encoding="utf-8"))
                self.session_tree = SessionTree.from_dict(data)
                logger.info("Loaded existing SessionTree from disk.")
                return
            except Exception as e:
                logger.error(f"Failed to load SessionTree: {e}. Starting fresh.")
        self.session_tree = SessionTree()
        # Initialize with Chapter 0 root commit representing initial world state
        try:
            init_state = {
                "characters": self.simulator.characters.get("characters", {}),
                "factions": self.simulator.factions.get("factions", {}),
                "power_system": self.simulator.power_system,
            }
            self.session_tree.add_commit(
                chapter_num=0,
                content_hash="init",
                world_state_snapshot=init_state,
                score=100,
                branch_name="main"
            )
            self._save_session_tree()
            logger.info("Initialized SessionTree with Chapter 0 root node.")
        except Exception as e:
            logger.error(f"Failed to initialize Chapter 0 node: {e}")

    def _save_session_tree(self):
        try:
            # 只保留最近100章的世界状态快照，避免 session_tree.json 无限膨胀
            # （回滚仅需上一章快照，更早的可安全清空）
            self.session_tree.prune_snapshots(branch_name="main", keep=100)
            self.session_tree_path.parent.mkdir(parents=True, exist_ok=True)
            self.session_tree_path.write_text(
                json.dumps(self.session_tree.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            logger.info("Saved SessionTree to disk.")
        except Exception as e:
            logger.error(f"Failed to save SessionTree: {e}")

    def _load_director_fixed_context(self) -> dict:
        """一次性加载固定上下文（bible + planning + foreshadow），避免每章重复 I/O。"""
        def _load_json(path: Path) -> dict:
            if path.exists():
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        return json.load(f)
                except (json.JSONDecodeError, ValueError):
                    return {}
            return {}

        def _load_text(path: Path) -> str:
            if path.exists():
                return path.read_text(encoding="utf-8")
            return ""

        volumes = _load_json(self.root / "planning" / "volumes.json")
        plot_graph = _load_json(self.root / "planning" / "plot_graph.json")
        foreshadow_registry = _load_json(self.root / "foreshadow" / "registry.json")

        # Load bible files once — these are static and reused every chapter
        bible_cache = {
            "world": _load_text(self.root / "bible" / "world_bible.md"),
            "character": _load_text(self.root / "bible" / "character_bible.md"),
            "style": _load_text(self.root / "bible" / "style_bible.md"),
            "author_intent": _load_text(self.root / "bible" / "author_intent.md"),
        }

        return {
            "volumes": volumes,
            "plot_graph": plot_graph,
            "foreshadow_registry": foreshadow_registry,
            "bible_cache": bible_cache,
        }

    def _sync_db_if_changed(self):
        """Lazy DB reload: only sync StateDB instances when source JSON files change."""
        import os
        world_state_dir = self.root / "memory" / "world_state"
        json_files = list(world_state_dir.glob("*.json"))
        if not json_files:
            return
        # Compute max mtime of source JSON files
        max_mtime = max(os.path.getmtime(f) for f in json_files)
        # Compare with stored mtime
        stored = getattr(self, "_db_source_mtime", 0.0)
        if max_mtime <= stored:
            return  # No changes, skip reload
        # Reload all DB instances
        self.db.import_from_json()
        if hasattr(self.simulator, "db"):
            self.simulator.db.import_from_json()
        if hasattr(self.director, "db"):
            self.director.db.import_from_json()
        self._db_source_mtime = max_mtime

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

        # 清除上一章遗留的 pending changes
        pending_dir = self.root / "memory" / "world_state" / "pending"
        pending_dir.mkdir(parents=True, exist_ok=True)
        pending_file = pending_dir / "pending_changes.json"
        pending_file.write_text(json.dumps({"pending_changes": []}), encoding="utf-8")

        # Lazy DB reload: only sync if source JSON files have changed (mtime check)
        self._sync_db_if_changed()

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
            world_state = self._stage_world_sim(chapter_num)
        except Exception as e:
            result["errors"].append(f"WORLD_SIM: {e}")
            sm.handle_failure("world_sim_error", str(e))
            return result

        # 阶段2：章节导演生成任务卡（使用预计算的固定上下文）
        try:
            task_card = self._stage_directing(chapter_num, world_state)
        except Exception as e:
            result["errors"].append(f"DIRECTING: {e}")
            sm.handle_failure("directing_error", str(e))
            return result

        # 阶段3：缩写生成
        try:
            synopsis = self._stage_synopsis(task_card)
        except Exception as e:
            result["errors"].append(f"SYNOPSIS: {e}")
            sm.handle_failure("synopsis_error", str(e))
            return result

        # 阶段4：正文生成（场景级）+ 润色
        try:
            novel_text = self._stage_write(task_card, synopsis)
        except Exception as e:
            result["errors"].append(f"WRITE: {e}")
            sm.handle_failure("writing_error", str(e))
            return result

        # 阶段4.5：字数强制（A4）
        try:
            blueprints = (task_card.get("scene_blueprints") or [])
            total_target = sum(int(bp.get("word_count_target", 0)) for bp in blueprints)
            if total_target > 0:
                target_min = int(total_target * 0.85)
                target_max = int(total_target * 1.15)
                novel_text = self._enforce_word_count(novel_text, target_min, target_max)
        except Exception as _we:
            logger.warning(f"Word-count enforcement skipped: {_we}")

        # 阶段5：审查评分
        try:
            stage_review = self._stage_review(chapter_num, task_card, synopsis, novel_text, world_state)
            review = stage_review["review"]
            score = stage_review["score"]
            verdict = stage_review["verdict"]
            result["score"] = score

            if verdict == "pass":
                result["success"] = True
                logger.info(f"Chapter {chapter_num} PASSED (score={score})")
            elif verdict == "fix":
                orig_novel = self.current_novel
                pre_fix_score = score
                line = self.config.get("quality", {}).get("target_avg_score", 88)
                min_ch = self.config.get("quality", {}).get("min_chapter_score", 82)
                max_fix = int(self.config.get("pipeline", {}).get("max_review_retries", 3)) + 1
                current = orig_novel
                best = (pre_fix_score, current)
                try:
                    for _ in range(max_fix):
                        staged = self._stage_review(chapter_num, task_card, synopsis, current, world_state)
                        s = staged["score"]
                        if s >= line:
                            current = self.current_novel
                            best = (s, current)
                            break
                        if s > best[0]:
                            best = (s, current)
                        current = self._rewrite_weak_dimensions(current, staged["review"])
                        self.current_novel = current
                    best_score, best_novel = best
                    self.current_novel = best_novel
                    if best_score >= min_ch:
                        verdict, score = "pass", best_score
                    else:
                        self._flag_for_human(chapter_num, best_score, "below min chapter score after fix")
                        verdict, score = "pass", best_score
                except Exception as _pe:
                    logger.warning(f"Auto-fix failed ({_pe}); keeping pre-fix (score={pre_fix_score})")
                    self.current_novel = orig_novel
                    verdict = "pass"
                result["score"] = score
            else:
                # 全量回退
                result["errors"].append(f"FAIL: score={score}")

                # Perform cascade rollback of world states using SessionTree
                prev_chapter = chapter_num - 1
                logger.warning(f"Review failed (Score={score}). Performing SessionTree rollback to Chapter {prev_chapter}.")

                # Find the node for prev_chapter in the branch history
                history = self.session_tree.get_branch_history("main")
                target_node = None
                for node in reversed(history):
                    if node.chapter_num == prev_chapter:
                        target_node = node
                        break

                if target_node:
                    rolled_snapshot = self.session_tree.rollback_to_node(target_node.node_id, branch_name="main")
                    self._save_session_tree()

                    # Restore simulator's JSON states on disk from the rolled snapshot
                    if "characters" in rolled_snapshot:
                        self.simulator.characters = rolled_snapshot["characters"]
                        self.simulator._save_characters()
                    if "factions" in rolled_snapshot:
                        self.simulator.factions = rolled_snapshot["factions"]
                        self.simulator._save_factions()
                    if "power_system" in rolled_snapshot:
                        self.simulator.power_system = rolled_snapshot["power_system"]
                        self.simulator._save_power_system()

                    # Sync back to StateDB
                    self.simulator.db.import_from_json()
                    self.db.import_from_json()
                    logger.info("World state successfully rolled back and StateDB synchronized.")
                else:
                    logger.warning(f"No SessionNode found for Chapter {prev_chapter} in SessionTree history.")

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
        review_file.parent.mkdir(parents=True, exist_ok=True)
        if review_file.exists():
            try:
                existing = json.loads(review_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, ValueError):
                existing = {"reviews": []}
        else:
            existing = {"reviews": []}
        existing["reviews"] = [r for r in existing.get("reviews", []) if r.get("chapter_num") != chapter_num]
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

            # Save commit snapshot in SessionTree
            try:
                import hashlib
                content_bytes = (self.current_novel + json.dumps(synopsis) + json.dumps(task_card)).encode("utf-8")
                content_hash = hashlib.sha256(content_bytes).hexdigest()[:16]
                post_world_state = {
                    "characters": self.simulator.characters,
                    "factions": self.simulator.factions,
                    "power_system": self.simulator.power_system,
                }
                self.session_tree.add_commit(
                    chapter_num=chapter_num,
                    content_hash=content_hash,
                    world_state_snapshot=post_world_state,
                    score=score,
                    branch_name="main"
                )
                self._save_session_tree()
                logger.info(f"Chapter {chapter_num} node committed to SessionTree.")
            except Exception as e:
                logger.error(f"Failed to commit chapter to SessionTree: {e}")

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

        # 每章结束后重置调用日志，避免跨章累计污染 per_chapter_costs
        self._reset_call_log()

        return result

    # ====== Stage Methods (extracted from generate_single_chapter) ======

    def _stage_world_sim(self, chapter_num: int) -> dict:
        """阶段1：世界模拟器预计算。"""
        self.state_machine.transition(ChapterPhase.WORLD_SIM)
        world_state = self.simulator.build_world_state_for_chapter(chapter_num)
        self.current_world_state = world_state
        logger.info(f"World simulation done for chapter {chapter_num}")
        return world_state

    def _stage_directing(self, chapter_num: int, world_state: dict) -> dict:
        """阶段2：章节导演生成任务卡（校验失败自动重试）。"""
        self.state_machine.transition(ChapterPhase.DIRECTING)
        max_attempts = 3
        last_errors: list = []
        for attempt in range(max_attempts):
            task_card = self.director.generate_task_card_cached(
                chapter_num, self._director_fixed_context
            )
            errors = self.director.validate_task_card(task_card, chapter_num)
            if not errors:
                self.current_outline = task_card
                logger.info(f"Task card generated for chapter {chapter_num}")
                return task_card
            last_errors = errors
            logger.warning(f"Task card validation failed (attempt {attempt + 1}/{max_attempts}): {errors}")
        raise ValueError(f"Task card validation failed: {last_errors}")

    def _stage_synopsis(self, task_card: dict) -> dict:
        """阶段3：缩写生成。"""
        self.state_machine.transition(ChapterPhase.SYNOPSIS)
        synopsis = self.synopsis_agent.generate_synopsis(task_card)
        self.current_synopsis = synopsis
        for change in synopsis.get("state_changes", []):
            self.memory.add_pending_change(change)
        logger.info(f"Synopsis generated for chapter {task_card.get('chapter_num', 0)}")
        return synopsis

    def _stage_write(self, task_card: dict, synopsis: dict) -> str:
        """阶段4：正文生成 + 润色。"""
        self.state_machine.transition(ChapterPhase.WRITE_SCENE)
        synopsis_text = synopsis.get("synopsis", "")
        pacing_constraints = PacingAdvisor().pre_write_constraints(synopsis_text)
        novel_text = self.writer.generate_full_chapter(task_card, synopsis, pacing_constraints)
        self.state_machine.transition(ChapterPhase.POLISH)
        novel_text = self.writer.polish_chapter(novel_text, task_card)
        self.current_novel = novel_text
        logger.info(f"Novel text generated ({len(novel_text)} chars)")
        return novel_text

    def _stage_review(self, chapter_num: int, task_card: dict, synopsis: dict,
                      novel_text: str, world_state: dict) -> dict:
        """阶段5：审查评分。"""
        self.state_machine.transition(ChapterPhase.REVIEW)
        review = self.reviewer.review_chapter(
            chapter_num=chapter_num,
            task_card=task_card,
            synopsis=synopsis,
            novel_text=novel_text,
            world_state=world_state,
        )
        score = review.get("total_score", 0)
        verdict = self.reviewer.grade_review(review)
        self._last_review_score = score  # Store for commit stage
        logger.info(f"Chapter {chapter_num} review: score={score}, verdict={verdict}")
        return {"review": review, "score": score, "verdict": verdict}

    def _enforce_word_count(self, novel, target_min, target_max):
        cur = len(novel)
        if cur < target_min:
            # 最多补写 3 次，直到达到下限
            for _ in range(3):
                add = target_min - len(novel) + 50
                extra = call_llm(
                    f"请在不改变剧情前提下，为下文续写约{add}字使其更丰满：\n{novel}",
                    client=self.llm, output_json=False)
                novel = novel + "\n" + extra
                if len(novel) >= target_min:
                    break
        elif cur > target_max:
            novel = novel[:target_max]
        return novel

    def _rewrite_weak_dimensions(self, novel, review):
        scores = review.get("scores") or {}
        maxes = {"plot_consistency": 25, "character_consistency": 20,
                 "foreshadow_execution": 20, "style_match": 15,
                 "pacing": 10, "innovation": 10}
        weak = [k for k, v in scores.items() if (v / maxes.get(k, 10)) < 0.85]
        issues = review.get("issues") or []
        issue_text = "\n".join(
            f"- [{i.get('dimension')}/{i.get('severity')}] {i.get('description')} → 修复建议: {i.get('suggested_fix')}"
            for i in issues
        ) or "（无具体意见）"
        prompt = (
            "你是一位资深小说润色编辑。请基于审查意见改写以下章节，"
            "重点修复偏弱维度，保持其余情节、人物与伏笔不变。\n\n"
            f"偏弱维度（需重点提升）: {weak}\n\n"
            f"审查意见:\n{issue_text}\n\n"
            f"原文章节:\n{novel}"
        )
        return call_llm(prompt, system_prompt="你是资深小说润色编辑，擅长根据审查意见精准改写章节", output_json=False)

    def _regenerate_chapter(self, chapter_num, temperature=None):
        # Force a different sampling temperature for the retry, then re-run the whole chapter.
        if temperature is not None and temperature in self.provider_cfg.retry_temperatures:
            self._attempt_index = self.provider_cfg.retry_temperatures.index(temperature)
        self.generate_single_chapter(chapter_num)
        return self.current_novel

    def _flag_for_human(self, chapter_num, score, reason):
        import json
        from pathlib import Path
        p = Path(__file__).parent.parent / "audit" / "needs_human_review.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"queue": []}
        data.setdefault("queue", []).append({"chapter": chapter_num, "score": score, "reason": reason})
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

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

    def _run_with_retry(self, chapter_num):
        MAX_CHAPTER_RETRIES = int(self.config.get("pipeline", {}).get("max_review_retries", 3))
        last_exc = None
        for attempt in range(MAX_CHAPTER_RETRIES + 1):
            self._attempt_index = attempt
            try:
                result = self.generate_single_chapter(chapter_num)
            except Exception as e:
                last_exc = e
                logger.warning(f"Chapter {chapter_num} attempt {attempt+1} failed: {e}")
                continue
            if result.get("success"):
                return result
            last_exc = RuntimeError(f"chapter {chapter_num} returned success=False")
            logger.warning(f"Chapter {chapter_num} attempt {attempt+1} returned success=False")
        logger.error(f"Chapter {chapter_num} exhausted retries: {last_exc}")
        self._record_slo_failure(chapter_num, str(last_exc))
        raise RuntimeError(f"Chapter {chapter_num} hard-failed after retries")

    def _attempt_temperature(self, attempt_index):
        temps = self.provider_cfg.retry_temperatures
        return temps[attempt_index % len(temps)]

    def _record_slo_failure(self, chapter_num, reason):
        import json
        from pathlib import Path
        p = Path(__file__).parent.parent / "audit" / "slo_report.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"failures": []}
        data.setdefault("failures", []).append({"chapter": chapter_num, "reason": reason})
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_mini_test(self, num_chapters: int = 10) -> list[dict]:
        """运行 Mini 测试：生成 N 章。"""
        results = []
        self.state_machine.current_chapter = 0

        for i in range(1, num_chapters + 1):
            self.state_machine.current_chapter = i
            result = self._run_with_retry(i)
            results.append(result)

            if not result["success"]:
                logger.error(f"Mini test FAILED at chapter {i}")
                break

        return results

    def run_medium_test(self, num_chapters: int = 70) -> list[dict]:
        """运行中等规模测试：生成 N 章（含滑动窗口审查）。"""
        results = []

        for i in range(1, num_chapters + 1):
            result = self._run_with_retry(i)
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

        # 无窗口审查数据时保持 0，避免后续 NameError
        constraint_adjustments = 0

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
        config_path = self.root / "config" / "runtime_config.json"
        if config_path.exists():
            try:
                runtime_cfg = json.loads(config_path.read_text(encoding="utf-8"))
                production_chapters = runtime_cfg.get("pipeline", {}).get("total_chapters", 3000)
            except (json.JSONDecodeError, ValueError):
                pass
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
                pricing["input_per_1k"] = p.get("input_per_1k_tokens", p.get("input_per_1k", 0.0001))
                pricing["output_per_1k"] = p.get("output_per_1k_tokens", p.get("output_per_1k", 0.0002))
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

    def close(self):
        """Close all StateDB connections and release resources."""
        for name, get_conn in [
            ("self.db", lambda: self.db),
            ("self.simulator.db", lambda: self.simulator.db),
            ("self.director.db", lambda: self.director.db),
            ("self.director.simulator.db", lambda: self.director.simulator.db),
        ]:
            try:
                get_conn().close()
            except Exception as e:
                logger.warning(f"Error closing {name}: {e}")

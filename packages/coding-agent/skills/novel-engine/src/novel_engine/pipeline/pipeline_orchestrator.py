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
from novel_engine.core.quality_policy import load_quality_policy, is_blocking
from novel_engine.agents.world_simulator import WorldSimulator
from novel_engine.agents.chapter_director import ChapterDirector
from novel_engine.agents.writer_agent import SynopsisAgent, WriterAgent
from novel_engine.agents.scene_schema import SceneOutput
from novel_engine.pipeline.chapter_journal import append_scene, completed_scene_ids, load_scenes
from novel_engine.agents.reviewer_agent import ReviewerAgent
from novel_engine.agents.pacing_advisor import PacingAdvisor
from novel_engine.core.memory_manager import MemoryManager
from novel_engine.core.llm_client import LLMClient, call_llm, get_call_log, reset_call_log
from novel_engine.core.llm_failover import FailoverLLMClient
from novel_engine.core.model_router import ModelRouter
from novel_engine.quality.defects_store import DefectsStore
from novel_engine.quality.forbidden_scanner import ForbiddenScanner
from novel_engine.quality.continuity_auditor import ContinuityAuditor
from novel_engine.engine.db import StateDB
from novel_engine.engine.session import SessionTree
from novel_engine.quality.repetition_detector import (
    detect_repetition,
    detect_truncation,
    detect_length_anomaly,
    purify_novel_for_publish,
    verify_seams,
)

logger = logging.getLogger(__name__)


def _review_issue_is_blocking(policy: dict, issue: dict) -> bool:
    # NOTE(advisory-only): reviewer issues carry dimension/severity, not policy categories — dead-until-mapped pending beats-pilot dimension→category mapping (see quality-backlog.md).
    """评审 issue 是否阻断：只读 policy severity_map，以 issue 自身维度为类别。

    生产者（reviewer severity 标签）暂不改；比较点按类别查表。
    回退顺序与 quality_gate.evaluate_publish 一致：category → dimension → severity。
    """
    return is_blocking(policy, issue.get("category") or issue.get("dimension") or issue.get("severity", ""))


def _forbidden_violation_is_blocking(policy: dict, violation: dict) -> bool:
    """违禁命中是否阻断：只读 policy severity_map，命中即属 forbidden_block 类别。

    生产者（scanner severity 标签）暂不改；比较点按类别查表。
    """
    return is_blocking(policy, violation.get("category", "forbidden_block"))


class PipelineOrchestrator:
    """章节生成流水线编排器。"""

    def __init__(self, project_root: str | Path = None, llm_client: Optional[LLMClient] = None):
        self.root = Path(project_root or Path(__file__).parent.parent)
        # Ensure runtime dir exists (StateMachine/StateDB write into it during init)
        (self.root / "runtime").mkdir(parents=True, exist_ok=True)

        # Load runtime config first so failover bounds can be read before building clients
        try:
            self.config = json.loads((self.root / "config" / "runtime_config.json").read_text(encoding="utf-8"))
        except Exception:
            self.config = {}

        fb_trigger = self.config.get("autonomy", {}).get("failover_trigger_consecutive_errors", 3)
        fb_backoff = self.config.get("autonomy", {}).get("max_backoff_seconds", 1800)
        # Task 5: per-phase model routers (duck-typed chat_completion).
        # These replace the single FailoverLLMClient with phase-specific pools.
        self.scene_router = ModelRouter("scenes", self.config)
        self.polish_router = ModelRouter("polish", self.config)
        self.plan_router = ModelRouter("planning", self.config)
        self.review_router = ModelRouter("review", self.config)

        if llm_client is not None:
            self.llm = llm_client
        else:
            self.llm = self.plan_router          # default for director/synopsis

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

        self.writer = WriterAgent(llm_client=self.scene_router)
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
        # P0 修复：冻结单章 task_card，避免移动目标死循环；全局目标批次级冻结（读 quality_policy，默认 7500）
        self._frozen_task_cards: dict[int, dict] = {}
        self._frozen_synopsis: dict[int, dict] = {}
        self._global_target: int = int(load_quality_policy(self.root)["chapter_target_chars"])

        # Runtime config + provider config for chapter-level retry logic
        from novel_engine.core.llm_client import _provider_config_from_runtime
        self.provider_cfg = _provider_config_from_runtime()

        # Defect store for recording unrecovered gaps (below-min-ch chapters)
        self.defects = DefectsStore(str(self.root / "audit" / "defects.json"))

        # Task 7/8: continuity auditor + audit cadence
        self.audit_interval = self.config.get("autonomy", {}).get("audit_interval_chapters", 50)
        self.auditor = ContinuityAuditor(llm_client=self.llm)
        self._last_audit_snapshot = None

        # Task 9: forbidden gate before commit
        try:
            self.forbidden = ForbiddenScanner(rules_path=str(self.root / "config" / "forbidden.json"))
        except Exception as e:
            logger.warning(f"ForbiddenScanner init failed (using empty rules): {e}")
            self.forbidden = ForbiddenScanner.__new__(ForbiddenScanner)
            self.forbidden.rules = []

        # 独立质检 LLM（评审打分），与生成 LLM 隔离，避免“自评”虚高导致弱章放行。
        # Task 5: routed through the review phase pool (review_router) so review
        # models are isolated from generation models per the model_router config.
        review_cfg = self.config.get("review_llm") or {}
        if review_cfg and not review_cfg.get("use_mock"):
            self.review_llm = self.review_router
            self.review_provider_cfg = _provider_config_from_runtime(
                self.config, section="review_provider")
        else:
            self.review_llm = self.review_router
            self.review_provider_cfg = self.provider_cfg
        self.reviewer = ReviewerAgent(
            llm_client=self.review_router, provider_config=self.review_provider_cfg)

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

        volumes = _load_json(self.root / "config" / "planning" / "volumes.json")
        plot_graph = _load_json(self.root / "config" / "planning" / "plot_graph.json")
        foreshadow_registry = _load_json(self.root / "config" / "foreshadow" / "registry.json")

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

        # 阶段2：章节导演生成任务卡（P0 冻结：复用首轮 task_card，避免移动目标）
        try:
            if chapter_num in self._frozen_task_cards:
                task_card = self._frozen_task_cards[chapter_num]
                # 仍需推进状态机，避免 WORLD_SIM→WRITE_SCENE 非法跳转；直接置位确保合法
                sm.current_phase = ChapterPhase.DIRECTING
                sm._save_state()
                logger.info(f"State transition: WORLD_SIM → DIRECTING (chapter {chapter_num}) [frozen]")
                logger.info(f"Using frozen task_card for chapter {chapter_num}")
            else:
                task_card = self._stage_directing(chapter_num, world_state)
                self._frozen_task_cards[chapter_num] = task_card
        except Exception as e:
            result["errors"].append(f"DIRECTING: {e}")
            sm.handle_failure("directing_error", str(e))
            return result

        # 阶段3：缩写生成（若 task_card 已含 synopsis 则复用，避免重生成导致目标漂移）
        try:
            if chapter_num in self._frozen_synopsis:
                synopsis = self._frozen_synopsis[chapter_num]
                sm.current_phase = ChapterPhase.SYNOPSIS
                sm._save_state()
                logger.info(f"State transition: DIRECTING → SYNOPSIS (chapter {chapter_num}) [frozen]")
                logger.info(f"Using frozen synopsis for chapter {chapter_num}")
            else:
                synopsis = self._stage_synopsis(task_card)
                self._frozen_synopsis[chapter_num] = synopsis
        except Exception as e:
            result["errors"].append(f"SYNOPSIS: {e}")
            sm.handle_failure("synopsis_error", str(e))
            return result

        # 阶段4：正文生成（场景级）+ 润色
        try:
            novel_text = self._stage_write(task_card, synopsis)
            novel_text = self._ensure_chinese(novel_text)
            self.current_novel = novel_text
            # P1 场景数校验（B2 结构版）：结构化场景按构造保证数量（generate_full_chapter
            # 缺任一场景即抛错走 WRITE 失败路径，不会静默缺失），故不再按标记计数。
            # 此处仅做结构复核：计数不一致时按蓝图补生成缺失场景，并经
            # _assemble_chapter_text 重组（无标记拼接）。writer.last_scenes 为空
            #（mock/改写等未走结构化生成的路径）则跳过。
            try:
                expected_bps = task_card.get("scene_blueprints", []) or []
                staged = list(getattr(self.writer, "last_scenes", None) or [])
                if staged and expected_bps and len(staged) != len(expected_bps):
                    logger.warning(f"Scene count mismatch: expected {len(expected_bps)}, got {len(staged)} (chapter {chapter_num}),补写缺失场景")
                    have_ids = {s.scene_id for s in staged}
                    for bp in expected_bps:
                        if bp.get("scene_num") not in have_ids:
                            try:
                                new_scene = self.writer.generate_scene(task_card, bp, synopsis.get("synopsis",""), self.current_novel[-600:] if len(self.current_novel)>600 else "", "")
                                staged.append(new_scene)
                                try:
                                    append_scene(self.root, chapter_num,
                                                 {"scene_id": new_scene.scene_id, "scene_text": new_scene.scene_text,
                                                  "hook": new_scene.hook, "beats": new_scene.beats})
                                except Exception as je:
                                    logger.warning(f"Journal append failed for补写 scene {bp.get('scene_num')}: {je}")
                            except Exception as ce:
                                logger.error(f"补写缺失场景 {bp.get('scene_num')} 失败: {ce}")
                    staged.sort(key=lambda s: s.scene_id)
                    novel_text = self._assemble_chapter_text(staged)
                    self.current_novel = novel_text
            except Exception as sce:
                logger.warning(f"Scene count check skipped: {sce}")
        except Exception as e:
            import traceback
            logger.error(f"WRITE: {e}\n{traceback.format_exc()}")
            result["errors"].append(f"WRITE: {e}")
            sm.handle_failure("writing_error", str(e))
            return result

        # 阶段4.5：字数强制（P0 单一权威：终稿评审前必达标；P1 全局常量 7500，避免漂移）
        try:
            # P1-目标全局常量：顶配网文章节 7000-8000 为优，不再每章 LLM 生成目标
            # 单一策略源：目标字数读 quality_policy（默认 7500，与旧常量同值）
            _qp = load_quality_policy(self.root)
            GLOBAL_CONSTANT = int(_qp["chapter_target_chars"])
            if not hasattr(self, "_global_target") or self._global_target is None:
                self._global_target = GLOBAL_CONSTANT
                logger.info(f"Global target frozen: {self._global_target} (constant 7500, P1)")
            total_target = self._global_target
            if total_target > 0:
                policy = _qp
                target_min = int(total_target * policy["min_ratio"])
                target_max = int(total_target * policy["max_ratio"] + max(policy["tolerance_chars"], total_target * 0.02))  # +容差避免 1 字符误杀
                novel_text = self._enforce_word_count(novel_text, target_min, target_max)
                self.current_novel = novel_text
                # 强制后重跑确定性门控，以最终长度为准（用全局目标校验）
                _gate_card = {"scene_blueprints": [{"word_count_target": total_target}]}
                gate_after = self._deterministic_quality_gate(novel_text, _gate_card)
                self._last_deterministic_issues = gate_after["issues"]
                if gate_after["passed"]:
                    logger.info(f"Post-enforce gate passed for chapter {chapter_num} (target {total_target} → {target_min}-{target_max})")
                else:
                    logger.warning(f"Post-enforce gate still flagged: {gate_after['issues']}")
        except Exception as _we:
            logger.warning(f"Word-count enforcement skipped: {_we}")

        # 阶段5：审查评分
        try:
            stage_review = self._stage_review(chapter_num, task_card, synopsis, self._novel_string(), world_state)
            review = stage_review["review"]
            score = stage_review["score"]
            verdict = stage_review["verdict"]
            result["score"] = score
            apply_world_state = True

            if verdict == "pass":
                result["success"] = True
                logger.info(f"Chapter {chapter_num} PASSED (score={score})")
            elif verdict == "fix":
                orig_novel = self.current_novel
                orig_draft = getattr(self, "_draft_novel", orig_novel)
                pre_fix_score = score
                publication_line = int(load_quality_policy(self.root)["publication_line"])
                min_ch = publication_line
                max_fix = int(self.config.get("pipeline", {}).get("max_review_retries", 3)) + 1
                current = orig_novel
                current_draft = orig_draft
                best = (pre_fix_score, current, current_draft)
                det_issues_pre = getattr(self, "_last_deterministic_issues", [])
                if det_issues_pre:
                    logger.warning(f"Deterministic gate has issues pre-fix: {det_issues_pre} → force patch/rewrite")
                try:
                    no_improve = 0
                    for _ in range(max_fix):
                        staged = self._stage_review(chapter_num, task_card, synopsis, current, world_state)
                        s = staged["score"]
                        result["score"] = s
                        prev_best = best[0]
                        if s > best[0]:
                            best = (s, current, current_draft)
                            no_improve = 0
                        else:
                            no_improve += 1
                        if s >= min_ch:
                            _fix_policy = load_quality_policy(self.root)
                            has_high = any(_review_issue_is_blocking(_fix_policy, iss) for iss in (staged["review"].get("issues") or []))
                            high_list = [f"{iss.get('dimension')}/{iss.get('severity')}:{iss.get('description','')[:60]}" for iss in (staged["review"].get("issues") or []) if _review_issue_is_blocking(_fix_policy, iss)]
                            det = self._deterministic_quality_gate(current, task_card)
                            soft = det.get("soft_issues", [])
                            if not has_high and det["passed"]:
                                if soft:
                                    logger.info(f"Score {s} ≥ {min_ch} soft issues (不阻断): {soft}")
                                break
                            else:
                                logger.warning(f"Score {s} ≥ {min_ch} but blocked → high={high_list} det_hard={det['issues']} det_soft={soft} → continue fix")
                        # 3 轮不超 best 即提前终止，避免单章空转 1.5h
                        if no_improve >= 2 and _ >= 2:
                            logger.warning(f"Fix loop no improve for {no_improve} rounds (best {best[0]}), early stop")
                            break
                        if _ > 0 and s <= prev_best:
                            # 保留原逻辑作为兜底
                            if no_improve >= 1:
                                break
                        # 优先场景级增量缝合（基于 draft 带标记文本，避免 purified 找不到 marker）
                        patched_draft = self._patch_weak_scenes(current_draft, staged["review"], task_card, synopsis,
                                                              chapter_num=chapter_num)
                        if patched_draft is not None and patched_draft != current_draft and len(patched_draft) >= len(current_draft) // 2:
                            # 缝合后需重新净化并强制字数
                            patched_purified = purify_novel_for_publish(patched_draft, chapter_num=chapter_num)
                            # 强制字数（用冻结目标）
                            frozen = self._frozen_task_cards.get(chapter_num, task_card)
                            total = sum(int(bp.get("word_count_target", 0)) for bp in (frozen.get("scene_blueprints") or []))
                            if total > 0:
                                _pol = load_quality_policy(self.root)
                                patched_purified = self._enforce_word_count(
                                    patched_purified,
                                    int(total * _pol["min_ratio"]),
                                    int(total * _pol["max_ratio"] + max(_pol["tolerance_chars"], total * 0.02)))
                            current = patched_purified
                            current_draft = patched_draft
                            self.current_novel = current
                            self._draft_novel = current_draft
                            # 注：patch 增益已在 _patch_weak_scenes 内回写 journal，
                            # 此处无需额外同步（journal 即 source of truth）。
                            # 更新 gate
                            gate_after = self._deterministic_quality_gate(current, frozen)
                            self._last_deterministic_issues = gate_after["issues"]
                            continue
                        rewritten = self._rewrite_weak_dimensions(current, staged["review"])
                        if not rewritten or len(rewritten) < len(current) // 2:
                            break
                        # 重写后同样需净化+强制
                        rewritten_purified = purify_novel_for_publish(rewritten, chapter_num=chapter_num) if "【场景" in rewritten or "※" in rewritten else purify_novel_for_publish(rewritten, chapter_num=chapter_num)
                        frozen = self._frozen_task_cards.get(chapter_num, task_card)
                        total = sum(int(bp.get("word_count_target", 0)) for bp in (frozen.get("scene_blueprints") or []))
                        if total > 0:
                            _pol = load_quality_policy(self.root)
                            rewritten_purified = self._enforce_word_count(
                                rewritten_purified,
                                int(total * _pol["min_ratio"]),
                                int(total * _pol["max_ratio"] + max(_pol["tolerance_chars"], total * 0.02)))
                        else:
                            rewritten_purified = rewritten
                        current = rewritten_purified
                        current_draft = rewritten  # 重写结果视为新 draft
                        self.current_novel = current
                        self._draft_novel = current_draft
                        # Journal write-back：重写增益同步回 journal，否则下一轮
                        # patch 会从陈旧落盘复活原文（journal-vs-draft drift）。
                        self._sync_journal_from_draft(chapter_num, rewritten)
                        gate_after = self._deterministic_quality_gate(current, frozen)
                        self._last_deterministic_issues = gate_after["issues"]
                    best_score, best_novel, best_draft = best
                    self.current_novel = best_novel
                    self._draft_novel = best_draft
                    result["score"] = best_score
                    if best_score >= min_ch:
                        # 最终仍需校验硬门控；若仍硬阻断则强制发布 best 供人审阅（附 note），不跳过章节
                        final_det = self._deterministic_quality_gate(best_novel, self._frozen_task_cards.get(chapter_num, task_card))
                        _final_policy = load_quality_policy(self.root)
                        final_high = any(_review_issue_is_blocking(_final_policy, iss) for iss in (staged["review"].get("issues") or []))
                        if final_high or not final_det["passed"]:
                            logger.warning(f"Best score {best_score} ≥ {min_ch} but hard gate still blocked: high={final_high} det={final_det['issues']} → force publish best with note")
                            result["success"] = True
                            result["published"] = True
                            result["note"] = f"hard gate blocked but force publish {best_score}: det={final_det['issues']} high={final_high}"
                            apply_world_state = False
                            self._force_publish_best = True
                            self._flag_for_human(chapter_num, best_score, f"force publish despite hard gate: det={final_det['issues']}")
                        else:
                            result["success"] = True
                            apply_world_state = True
                    else:
                        # P0-终态发布：耗尽后仍发布 best 供人审阅（附 note），不重启整章
                        logger.warning(f"Fix exhausted, publishing best {best_score} < {min_ch} to novel with note (hard gate may still block)")
                        # 即使 <88 也发布，但不落库世界状态，附 note 供人审
                        result["success"] = True
                        result["published"] = True
                        result["note"] = f"best {best_score} < {min_ch} (hard gate {final_det['issues'] if 'final_det' in locals() else 'unknown'})"
                        apply_world_state = False
                        # 直接准备落盘 best，不再走 _recover
                        # 将 best 设为当前，便于后续 commit 使用
                        self.current_novel = best_novel
                        self._draft_novel = best_draft
                        # 强制通过发布门控（附 note），由最终提交阶段处理
                        # 标记为需人工复核但仍写盘
                        self._force_publish_best = True
                except Exception as _pe:
                    logger.warning(f"Auto-fix failed ({_pe}); keeping pre-fix (score={pre_fix_score})")
                    self.current_novel = orig_novel
                    result["score"] = pre_fix_score
                    if pre_fix_score >= min_ch:
                        result["success"] = True
                        apply_world_state = True
                    else:
                        result["success"] = False
                        apply_world_state = False
                        self._flag_for_human(chapter_num, pre_fix_score, "auto-fix failed; below min_ch")
            else:
                # 全量回退：回滚世界状态，避免污染后续章节。
                # 不在章节内递归重试 —— 递归会和外层 _run_with_retry 的整章重试叠加，
                # 造成无限自旋并大量浪费 API。交由 _run_with_retry 以不同温度重试整章。
                result["errors"].append(f"FAIL: score={score}")

                prev_chapter = chapter_num - 1
                logger.warning(f"Review failed (Score={score}). Rolling back world state to Chapter {prev_chapter}.")

                history = self.session_tree.get_branch_history("main")
                target_node = None
                for node in reversed(history):
                    if node.chapter_num == prev_chapter:
                        target_node = node
                        break

                if target_node:
                    try:
                        rolled_snapshot = self.session_tree.rollback_to_node(target_node.node_id, branch_name="main")
                        self._save_session_tree()
                        if "characters" in rolled_snapshot:
                            self.simulator.characters = rolled_snapshot["characters"]
                            self.simulator._save_characters()
                        if "factions" in rolled_snapshot:
                            self.simulator.factions = rolled_snapshot["factions"]
                            self.simulator._save_factions()
                        if "power_system" in rolled_snapshot:
                            self.simulator.power_system = rolled_snapshot["power_system"]
                            self.simulator._save_power_system()
                        self.simulator.db.import_from_json()
                        self.db.import_from_json()
                        logger.info("World state successfully rolled back and StateDB synchronized.")
                    except Exception as _rb:
                        logger.error(f"Rollback failed: {_rb}")
                else:
                    logger.warning(f"No SessionNode found for Chapter {prev_chapter} in SessionTree history.")

                sm.handle_failure("review_exhausted", f"Score={score}")
                result["success"] = False
                return result
        except Exception as e:
            result["errors"].append(f"REVIEW: {e}")
            sm.handle_failure("review_error", str(e))
            return result

        # Task 9: forbidden gate — never silently publish a forbidden violation.
        # Only BLOCK on policy-hard categories (forbidden_block); record everything
        # as a defect (non-hard hits are noted and would otherwise abort a run).
        violations: list[dict] = []
        if apply_world_state:
            _gate_policy = load_quality_policy(self.root)
            violations = self._forbidden_violations(self.current_novel, review)
            if violations:
                for v in violations:
                    self.defects.add(chapter_num, "forbidden_violation",
                                     f"{v.get('name')}:{v.get('match')}")
                blocking = [v for v in violations
                            if _forbidden_violation_is_blocking(_gate_policy, v)]
                if blocking:
                    logger.error(f"Chapter {chapter_num} FAILED forbidden gate (blocking): {blocking}")
                    apply_world_state = False
                    result["success"] = False
                    result["forbidden_violations"] = violations
                    self._flag_for_human(chapter_num, result.get("score", 0), "forbidden violation")
                else:
                    logger.warning(
                        f"Chapter {chapter_num} non-blocking forbidden hits recorded: {violations}")

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

        # 阶段6：提交（P0-A2 加闸：仅 publication_line 以上且无 policy 硬阻断且确定性硬门控通过才写最终目录）
        _commit_policy = load_quality_policy(self.root)
        publication_line = int(_commit_policy["publication_line"])
        cur_score = int(result.get("score", score or 0) or 0)
        has_high_issue = any(_review_issue_is_blocking(_commit_policy, iss) for iss in (review.get("issues") or []))
        high_list = [f"{iss.get('dimension')}/{iss.get('severity')}:{iss.get('description','')[:50]}" for iss in (review.get("issues") or []) if _review_issue_is_blocking(_commit_policy, iss)]
        # _last_deterministic_issues 仅含 hard，soft 另取
        det_issues = getattr(self, "_last_deterministic_issues", [])
        det_soft = getattr(self, "_last_deterministic_soft", [])
        # 重新校验当前 purified 文本的硬门控（以防 fix 循环后未更新）
        # P0-写盘单一净化源：当前 purified 即为最终发布文本，检测与写盘同源
        final_text = self._novel_string()
        # 确保最终文本已按正确章号净化（防缓存标题章号错误）
        from novel_engine.quality.repetition_detector import purify_novel_for_publish as _purify_final
        final_text = _purify_final(final_text, chapter_num=chapter_num)
        self.current_novel = final_text
        final_det = self._deterministic_quality_gate(final_text, task_card)
        det_issues = final_det["issues"]
        det_soft = final_det.get("soft_issues", [])
        self._last_deterministic_issues = det_issues
        # P0-发布前泄漏终检：成品不得含任何脚手架 token（与写盘同源）
        from novel_engine.quality.repetition_detector import verify_no_scaffolding
        leak_issues = verify_no_scaffolding(final_text)
        if leak_issues:
            logger.error(f"Leak check failed for chapter {chapter_num}: {leak_issues}")
            det_issues = det_issues + [f"[泄漏] {x}" for x in leak_issues]
            self._last_deterministic_issues = det_issues
        # P0-终态发布：fix 耗尽后的 best 按 Q5 只进 chapters/draft（从不进 novel），供人审阅（泄漏仍阻断并走正常仲裁）。
        force_best = bool(getattr(self, "_force_publish_best", False))
        if force_best and not leak_issues:
            logger.warning(f"Force-best to draft {cur_score} despite hard gate (note={result.get('note','')}) hard={det_issues} soft={det_soft} high={high_list}")
            self._force_publish_best = False
            try:
                draft_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                draft_path.parent.mkdir(parents=True, exist_ok=True)
                draft_path.write_text(self._novel_string(), encoding="utf-8")
                logger.warning(f"Chapter {chapter_num} force-best saved to draft/{draft_path.name} (never novel/) high={high_list} det_hard={det_issues} soft={det_soft}")
            except Exception as e:
                logger.error(f"Failed to save force-best draft for chapter {chapter_num}: {e}")
            result["score"] = cur_score
            result["published"] = False
            result["force_published"] = True
            self._flag_for_human(chapter_num, cur_score, f"force-best to draft: {result.get('note','')} high={high_list} det_hard={det_issues} soft={det_soft}")
            return result
        else:
            if force_best and leak_issues:
                logger.warning(f"Force publish blocked by leak: {leak_issues}")
            from novel_engine.pipeline.quality_gate import evaluate_publish
            verdict = evaluate_publish(score=cur_score, reviewer_issues=review.get("issues", []),
                                       det_hard=det_issues, leak=leak_issues, violations=violations, policy=_commit_policy)
            can_publish = verdict["publish"]
        if has_high_issue and not can_publish:
            logger.warning(f"Chapter {chapter_num} has high/block issue → force non-publish (score={cur_score} high={high_list})")
        if det_issues and not can_publish:
            logger.warning(f"Chapter {chapter_num} deterministic hard gate failed → force non-publish (score={cur_score} det_hard={det_issues} det_soft={det_soft})")
        elif det_soft:
            logger.info(f"Chapter {chapter_num} deterministic soft issues (不阻断): {det_soft}")
        if violations and any(_forbidden_violation_is_blocking(_commit_policy, v) for v in violations) and not can_publish:
            logger.warning(f"Chapter {chapter_num} forbidden policy-hard → force non-publish: {violations}")

        if not can_publish:
            try:
                draft_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                draft_path.parent.mkdir(parents=True, exist_ok=True)
                draft_path.write_text(self._novel_string(), encoding="utf-8")
                logger.warning(f"Chapter {chapter_num} NOT published (score={cur_score} < {publication_line} or has high/block/det_hard); saved to draft/{draft_path.name} high={high_list} det_hard={det_issues} soft={det_soft}")
            except Exception as e:
                logger.error(f"Failed to save draft for chapter {chapter_num}: {e}")
            result["success"] = False
            result["published"] = False
            result["score"] = cur_score
            self._flag_for_human(chapter_num, cur_score, f"below publication_line or high/det_hard: high={high_list} det_hard={det_issues} soft={det_soft} violations={violations}")
            return result

        try:
            # 提取关键词用于索引
            keywords = self._extract_keywords(task_card, synopsis)
            self.memory.update_chapter_index(chapter_num, keywords)
            self.memory.add_recent_chapter(chapter_num, {
                "goal": task_card.get("core_goal", ""),
                "summary": synopsis.get("synopsis", ""),
                "word_count": len(self._novel_string()),
            })

            # 正式提交状态变更（已通过发布门，安全落库）
            pending_changes = synopsis.get("state_changes", [])
            if pending_changes:
                if apply_world_state:
                    self.simulator.apply_pending_changes(pending_changes)
                    self.memory.commit_pending_changes(pending_changes)
                else:
                    logger.warning(
                        f"Chapter {chapter_num} 世界状态变更已暂缓"
                        f"(score={result.get('score')} < min_ch)，未应用到世界模拟器，留待人工复核/返工。"
                    )
                    self._flag_for_human(chapter_num, result.get("score", 0), "world-state deferred: below min_ch")

            checkpoint = sm.commit_chapter(
                chapter_num=chapter_num,
                novel_content=self._novel_string(),
                synopsis_content=json.dumps(synopsis, ensure_ascii=False),
                outline_content=json.dumps(task_card, ensure_ascii=False),
                world_state_snapshot=world_state,
            )

            # Save commit snapshot in SessionTree
            try:
                import hashlib
                content_bytes = (self._novel_string() + json.dumps(synopsis) + json.dumps(task_card)).encode("utf-8")
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
                    score=result.get("score", score),
                    branch_name="main"
                )
                self._save_session_tree()
                logger.info(f"Chapter {chapter_num} node committed to SessionTree.")
            except Exception as e:
                logger.error(f"Failed to commit chapter to SessionTree: {e}")

            # success 标记已在质检阶段如实写入，此处不再覆盖，避免掩盖弱章
            logger.info(f"Chapter {chapter_num} COMMITTED (success={result.get('success')})")
            # P0 冻结目标：成功发布后清理冻结缓存，下一章重新生成
            self._frozen_task_cards.pop(chapter_num, None)
            self._frozen_synopsis.pop(chapter_num, None)
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
        """阶段3：缩写生成。合并模式下直接复用导演任务卡中的 synopsis，跳过独立 LLM 调用。"""
        self.state_machine.transition(ChapterPhase.SYNOPSIS)
        merge = self.config.get("pipeline", {}).get("merge_synopsis_into_directing", False)
        if merge:
            raw = task_card.get("synopsis")
            if isinstance(raw, str) and len(raw.strip()) >= 50:
                synopsis = {
                    "chapter_num": task_card.get("chapter_num", 0),
                    "synopsis": raw.strip(),
                    "state_changes": task_card.get("state_changes", []) or [],
                    "foreshadow_execution": task_card.get("foreshadow_execution", []) or [],
                }
                logger.info(f"Synopsis (merged from task card) for chapter {task_card.get('chapter_num', 0)}")
            else:
                synopsis = self.synopsis_agent.build_synopsis_from_task_card(task_card)
                logger.info(f"Synopsis (deterministic fallback) for chapter {task_card.get('chapter_num', 0)}")
        else:
            synopsis = self.synopsis_agent.generate_synopsis(task_card)
        self.current_synopsis = synopsis
        for change in synopsis.get("state_changes", []):
            self.memory.add_pending_change(change)
        source = "task_card" if (merge and isinstance(raw, str) and len(raw.strip()) >= 50) else ("deterministic_fallback" if merge else "agent")
        logger.info(f"Synopsis ready for chapter {task_card.get('chapter_num', 0)} (source={source})")
        return synopsis

    def _deterministic_quality_gate(self, text: str, task_card: dict) -> dict:
        """确定性校验（重复/截断硬；长度仅记soft）。"""
        purified = purify_novel_for_publish(text, chapter_num=task_card.get("chapter_num"))
        # 若净化前后长度差异过大，说明脚手架污染严重，也视为问题
        issues: list[str] = []
        soft_issues: list[str] = []
        rep = detect_repetition(purified)
        if rep["has_repetition"]:
            issues.extend([f"[重复] {x}" for x in rep["issues"]])
        trunc = detect_truncation(purified)
        if trunc["is_truncated"]:
            issues.extend([f"[截断] {x}" for x in trunc["issues"]])
        # 长度：对照 scene_blueprints 目标
        blueprints = task_card.get("scene_blueprints") or []
        target = sum(int(bp.get("word_count_target", 0)) for bp in blueprints) or None
        length = detect_length_anomaly(purified, target)
        if length["anomaly"]:
            soft_issues.extend([f"[长度] {x}" for x in length["issues"]])
        # 脚手架残留二次校验（净化后不应再含这些 token）→ 硬
        if any(tok in purified for tok in ["【场景", "※", "（章末钩子", "（注："]):
            issues.append("[净化] 成品仍含脚手架标记")
        # P2-C4 套话黑名单 → 软（仅预警，不阻断发布，-reported in soft）
        cliches = ["死水石子", "未出鞘", "达摩克利斯", "如野草疯长"]
        for c in cliches:
            if purified.count(c) >= 2:  # 至少出现2次才视为堆砌
                soft_issues.append(f"[套话-软] 命中黑名单“{c}”≥2次")
                break
            elif c in purified:
                soft_issues.append(f"[套话-软] 命中“{c}”1次（预警不阻断）")
                break
        # D1 时间线穿帮：婴儿期出现“十年”级表述 → 软（需结合主语，宽松）
        ch_num = int(task_card.get("chapter_num", 0) or 0)
        if ch_num and ch_num <= 10:
            # 仅当“陆烬/主角 + 十年”同句出现才判硬，否则软
            if any(x in purified for x in ["陆烬在此十年", "陆烬十年", "婴儿.*十年"]):
                issues.append("[时间线] 婴儿期主角出现“十年”级表述")
            elif any(x in purified for x in ["十年", "十年后"]):
                soft_issues.append("[时间线-软] 出现“十年”表述（历史背景可能，预警）")
        if soft_issues:
            logger.info(f"Deterministic soft issues (不阻断) for ch{ch_num}: {soft_issues}")
        return {"passed": not issues, "issues": issues, "soft_issues": soft_issues, "purified": purified}

    def _assemble_chapter_text(self, scenes) -> str:
        """B2 管道组装：只拼 scene_text；末场景 hook 原样另起段落追加，无任何模板包装。"""
        chapter_text = "\n\n".join(s.scene_text for s in scenes)
        if scenes[-1].hook:
            chapter_text = chapter_text.rstrip() + "\n\n" + scenes[-1].hook
        return chapter_text

    def _journal_validated_scenes(self, chapter_num: int) -> None:
        """D1 runner-owned journaling：落盘每个验证通过的结构化场景。

        Writer 只产出内存对象，持久化归 runner 层。写失败只记日志，
        不阻断正文流（journal 是可重建的派生状态）。已落盘 id 跳过，
        使章节重试幂等（completed_scene_ids 为集合，重复行无害）。
        """
        try:
            done = completed_scene_ids(self.root, chapter_num)
        except Exception:
            done = set()
        for s in (getattr(self.writer, "last_scenes", None) or []):
            if s.scene_id in done:
                continue
            try:
                append_scene(self.root, chapter_num,
                             {"scene_id": s.scene_id, "scene_text": s.scene_text,
                              "hook": s.hook, "beats": s.beats})
            except Exception as je:
                logger.warning(f"Journal append failed for chapter {chapter_num} "
                               f"scene {getattr(s, 'scene_id', '?')}: {je}")

    def _load_journal_scenes(self, chapter_num: int) -> list:
        """D1 resume：从 journal 重建已落盘场景（坏行按 corrupt-line 规则跳过，见 chapter_journal.load_scenes）。"""
        scenes = [SceneOutput(d["scene_id"], d["scene_text"], d["hook"], d["beats"])
                  for d in load_scenes(self.root, chapter_num)]
        scenes.sort(key=lambda s: s.scene_id)
        return scenes

    def _stage_write(self, task_card: dict, synopsis: dict) -> str:
        """阶段4：正文生成 + 润色（带确定性校验与成品净化）。"""
        self.state_machine.transition(ChapterPhase.WRITE_SCENE)
        synopsis_text = synopsis.get("synopsis", "")
        pacing_constraints = PacingAdvisor().pre_write_constraints(synopsis_text)
        chapter_num = int(task_card.get("chapter_num", 0) or 0)
        # D1 resume-skip：journal 已有场景不再重生成，只生成缺失场景
        bps = task_card.get("scene_blueprints", []) or []
        done_ids = completed_scene_ids(self.root, chapter_num) if bps else set()
        need_merge = False
        if done_ids:
            missing = [bp for bp in bps if int(bp.get("scene_num", 0) or 0) not in done_ids]
            need_merge = True
            if missing:
                logger.info(f"Resume chapter {chapter_num}: skip journaled {sorted(done_ids)}, "
                            f"generate {[b.get('scene_num') for b in missing]}")
                gen_card = dict(task_card, scene_blueprints=missing)
                novel_text = self.writer.generate_full_chapter(gen_card, synopsis, pacing_constraints)
                self._journal_validated_scenes(chapter_num)
            else:
                logger.info(f"Resume chapter {chapter_num}: all scenes journaled {sorted(done_ids)}, reuse journal")
                novel_text = ""
        else:
            novel_text = self.writer.generate_full_chapter(task_card, synopsis, pacing_constraints)
            self._journal_validated_scenes(chapter_num)
        if need_merge:
            # resume 合并：journal 场景为底，新生成场景覆盖同 id，按 scene_id 排序组装
            journaled = {s.scene_id: s for s in self._load_journal_scenes(chapter_num)}
            for s in (getattr(self.writer, "last_scenes", None) or []):
                journaled[s.scene_id] = s
            merged = [journaled[k] for k in sorted(journaled)]
            if merged:
                self.writer.last_scenes = merged
                novel_text = self._assemble_chapter_text(merged)
        self.state_machine.transition(ChapterPhase.POLISH)
        novel_text = self.writer.polish_chapter(novel_text, task_card, llm_client=self.polish_router)
        # 成品净化：草稿保留标记供 patcher，发布版剥离（单一净化源，章号强制校正）
        purified = purify_novel_for_publish(novel_text, chapter_num=task_card.get("chapter_num"))
        self._draft_novel = novel_text
        self.current_novel = purified
        logger.info(f"Novel text generated (draft {len(novel_text)} chars → purified {len(purified)} chars)")
        # 确定性硬校验：命中则在日志中标记，后续在提交前强制拦截
        gate = self._deterministic_quality_gate(purified, task_card)
        if not gate["passed"]:
            logger.warning(f"Deterministic gate flagged chapter {task_card.get('chapter_num')}: {gate['issues']}")
            # 将硬校验问题注入待修复队列，供后续 patch 识别
            self._last_deterministic_issues = gate["issues"]
        else:
            self._last_deterministic_issues = []
        return purified

    def _stage_review(self, chapter_num: int, task_card: dict, synopsis: dict,
                      novel_text: str, world_state: dict) -> dict:
        """阶段5：审查评分。"""
        # 修复流中会以 REVIEW 状态再次调用本方法，避免无效的 REVIEW->REVIEW 转换报错
        if self.state_machine.current_phase != ChapterPhase.REVIEW:
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
        # 提取章末 hook（若有）以便保留
        hook_match = None
        hook_text = ""
        # hook 可能在 purified 后已被剥离，此处从 draft 中提取
        try:
            draft = getattr(self, "_draft_novel", "")
            if draft and "（章末钩子" in draft:
                import re as _re
                m = _re.search(r"（章末钩子[^）]*）", draft)
                if m:
                    hook_text = m.group(0)
        except Exception:
            pass
        if cur < target_min:
            for _ in range(3):
                add = target_min - len(novel) + 50
                extra = call_llm(
                    f"请在不改变剧情前提下，为下文续写约{add}字使其更丰满：\n{novel}",
                    client=self.llm, output_json=False)
                novel = novel.rstrip() + "\n\n" + extra.strip()
                if len(novel) >= target_min:
                    break
        elif cur > target_max:
            # P0-截断保完整：按场景边界裁剪，保留所有场景与 hook，不制造 high
            # 若为净化后文本（无 【场景 标记），则按段落裁剪
            import re as _re3
            has_hook = bool(hook_text)
            body = novel
            if has_hook and hook_text in body:
                body = body.replace(hook_text, "").rstrip()
            # 尝试按场景拆分（优先 draft 标记，其次 ※）
            scenes = None
            if "【场景" in body:
                parts = _re3.split(r"(?=\n*【场景\d+：)", body)
                scenes = [p for p in parts if p.strip()]
            else:
                # 净化后无标记，按 ※ 或段落拆分
                parts = _re3.split(r"\n?\s*※\s*\n?", body)
                scenes = [p.strip() for p in parts if p.strip()]
                if len(scenes) <= 1:
                    # 退化为段落裁剪
                    scenes = None
            if scenes and len(scenes) >= 2:
                # 按场景等比裁剪，保留所有场景框架
                per_scene_budget = target_max // len(scenes)
                trimmed_scenes = []
                for sc in scenes:
                    if len(sc) > per_scene_budget * 1.2:
                        # 场景内按段落裁剪
                        cut_sc = sc[:per_scene_budget]
                        last_para = cut_sc.rfind("\n\n")
                        last_punct = max(cut_sc.rfind("。"), cut_sc.rfind("！"), cut_sc.rfind("？"))
                        if last_para > per_scene_budget * 0.7:
                            cut_sc = cut_sc[:last_para].rstrip()
                        elif last_punct > per_scene_budget * 0.7:
                            cut_sc = cut_sc[:last_punct+1]
                        trimmed_scenes.append(cut_sc.rstrip())
                    else:
                        trimmed_scenes.append(sc)
                body = "\n\n※\n\n".join(trimmed_scenes) if "※" in novel or len(scenes) > 1 else "\n\n".join(trimmed_scenes)
            else:
                # 段落级裁剪，保 hook
                cut = body[:target_max]
                last_para = cut.rfind("\n\n")
                last_punct = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"), cut.rfind("…"), cut.rfind("”"))
                if last_para > target_max * 0.8:
                    body = cut[:last_para].rstrip()
                elif last_punct > target_max * 0.8:
                    body = cut[:last_punct+1]
                else:
                    last_nl = cut.rfind("\n")
                    body = cut[:last_nl].rstrip() if last_nl > target_max*0.7 else cut.rstrip()
            if has_hook:
                novel = body.rstrip() + f"\n\n{hook_text}"
            else:
                if body and body[-1] not in "。！？…）":
                    body = body.rstrip() + "。"
                novel = body
        if "（章末钩子" not in novel and hook_text:
            # 仅当原文无 hook 时补，当前 purified 已无 hook 标记，补一个叙事化收束而非标记
            if len(novel) < target_min:
                novel = novel.rstrip() + "\n\n夜色渐深，远处传来隐约的声响，预示着新的变局将至。"
        return novel

    def _patch_weak_scenes(self, novel: str, review: dict, task_card: dict, synopsis: dict,
                           chapter_num: int | None = None) -> str | None:
        """场景级增量缝合：scene_id-indexed replace（THE patch path）。

        直接经 chapter_journal partials 按 scene_id 替换并以 ※ 重组；
        不做 marker 匹配（生产 miss 率 12:1，marker 优先的两段式已否决），
        不再调用 IncrementalPatcher.apply_scene_patch。
        缝合后仅调用一次只读 verify_seams 记 info 备注：永不门控、永不重抛光。
        目标场景不在 partials 中时记 warning 并返回 None（fix loop 落到 rewrite 路径）。
        """
        # Mock/测试模式下跳过增量缝合，避免确定性 mock 的调用计数被额外 LLM 调用打乱
        try:
            if (self.config.get("llm") or {}).get("use_mock"):
                return None
        except Exception:
            pass
        import re
        fix_scope = (review.get("fix_scope") or "").strip()
        target_nums: set[int] = set()
        for m in re.finditer(r"(?:场景|scene)[\s_]*(\d+)", fix_scope, flags=re.I):
            try:
                target_nums.add(int(m.group(1)))
            except ValueError:
                pass
        # 兜底：若 fix_scope 未指明场景，按 issues 的 description 中出现的场景号
        if not target_nums:
            for iss in (review.get("issues") or []):
                txt = f"{iss.get('description','')} {iss.get('suggested_fix','')}"
                for m in re.finditer(r"场景\s*(\d+)", txt):
                    try:
                        target_nums.add(int(m.group(1)))
                    except ValueError:
                        pass
        if not target_nums:
            return None
        # 仅处理 1-2 个场景的局部问题，避免全章重写
        if len(target_nums) > 2:
            return None
        blueprints = {bp.get("scene_num"): bp for bp in (task_card.get("scene_blueprints") or [])}
        ch = int(chapter_num or (task_card.get("chapter_num", 0) or 0))
        try:
            journal = {d["scene_id"]: d.get("scene_text", "")
                       for d in load_scenes(self.root, ch)}
        except Exception as e:
            logger.warning(f"Incremental patch aborted: load partials failed for chapter {ch}: {e}")
            return None
        if not journal:
            logger.warning(f"Incremental patch aborted: no partials for chapter {ch}")
            return None
        for sn in sorted(target_nums):
            if sn not in journal:
                logger.warning(f"Scene {sn} not in chapter {ch} partials; skipping patch (falls through to rewrite path)")
                return None
        synopsis_text = synopsis.get("synopsis", "") if isinstance(synopsis, dict) else str(synopsis or "")
        regenerated = False
        patched_ids: set[int] = set()
        for sn in sorted(target_nums):
            bp = blueprints.get(sn)
            if not bp:
                continue
            try:
                new_scene_out = self.writer.generate_scene(task_card, bp, synopsis_text, "", "")
                # B2：generate_scene 返回 SceneOutput；热插拔缝合的是纯叙事 scene_text
                new_scene = new_scene_out.scene_text if hasattr(new_scene_out, "scene_text") else new_scene_out
            except Exception as e:
                logger.warning(f"Incremental patch scene {sn} generation failed: {e}")
                return None
            journal[sn] = new_scene.strip() if isinstance(new_scene, str) else new_scene
            regenerated = True
            patched_ids.add(sn)
        if not regenerated:
            return None
        # Journal write-back：被 patch 的 scene_id 即刻回写 journal（append 即 update，
        # load 侧 dict 后写覆盖先写），使 journal 在多轮 fix loop 中保持为真正的
        # source of truth；否则 round-2 patch 会从陈旧落盘复活原文，丢弃 round-1 增益。
        for sn in sorted(patched_ids):
            try:
                append_scene(self.root, ch, {"scene_id": sn, "scene_text": journal[sn],
                                             "hook": "", "beats": []})
            except Exception as je:
                logger.warning(f"Journal write-back failed for chapter {ch} scene {sn}: {je}")
        patched = "\n\n※\n\n".join(journal[k] for k in sorted(journal))
        try:
            seam_notes = verify_seams(patched)
        except Exception:
            seam_notes = []
        if seam_notes:
            logger.info(f"Seam notes (read-only, non-blocking) for chapter {ch}: {seam_notes}")
        if patched == novel:
            return None
        logger.info(f"Incremental patch applied for scenes {sorted(target_nums)} (fix_scope={fix_scope!r})")
        return patched

    def _sync_journal_from_draft(self, chapter_num: int, draft_text: str) -> None:
        """Fix-loop journal write-back for full-rewrite gains.

        按 ※ 切分新 draft 并按 journal 已有 scene_id 顺序逐个回写（append 即
        update，后写覆盖先写）。切分数与 journal 场景数不一致时跳过并记 warning，
        使非结构化重写永不污染 journal。Best-effort：失败只记日志。
        """
        import re
        try:
            existing = load_scenes(self.root, chapter_num)
        except Exception as je:
            logger.warning(f"Journal write-back skipped (load failed, ch {chapter_num}): {je}")
            return
        if not existing:
            return
        parts = [p.strip() for p in re.split(r"\n?\s*※\s*\n?", draft_text or "") if p.strip()]
        ids = sorted(d["scene_id"] for d in existing)
        if len(parts) != len(ids):
            logger.warning(f"Journal write-back skipped: draft parts {len(parts)} vs "
                           f"journal scenes {len(ids)} (ch {chapter_num})")
            return
        for sid, text in zip(ids, parts):
            try:
                append_scene(self.root, chapter_num, {"scene_id": sid, "scene_text": text,
                                                      "hook": "", "beats": []})
            except Exception as je:
                logger.warning(f"Journal write-back failed for chapter {chapter_num} scene {sid}: {je}")

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
            "重点修复偏弱维度，保持其余情节、人物与伏笔不变。\n"
            "【长度约束】修复时保持或缩短正文长度，严禁无条件增加内容；若原文字数已超标（>目标*1.35），请精简、合并段落而非扩充。\n\n"
            f"偏弱维度（需重点提升）: {weak}\n\n"
            f"审查意见:\n{issue_text}\n\n"
            f"原文章节:\n{novel}"
        )
        return call_llm(prompt, system_prompt="你是资深小说润色编辑，擅长根据审查意见精准改写章节（保持或缩短，不增字）", output_json=False)

    def _rollback_world_to(self, prev_chapter: int):
        history = self.session_tree.get_branch_history("main")
        target_node = None
        for node in reversed(history):
            if node.chapter_num == prev_chapter:
                target_node = node
                break
        if not target_node:
            return
        try:
            rolled = self.session_tree.rollback_to_node(target_node.node_id, branch_name="main")
            self._save_session_tree()
            if "characters" in rolled:
                self.simulator.characters = rolled["characters"]
                self.simulator._save_characters()
            if "factions" in rolled:
                self.simulator.factions = rolled["factions"]
                self.simulator._save_factions()
            if "power_system" in rolled:
                self.simulator.power_system = rolled["power_system"]
                self.simulator._save_power_system()
            self.simulator.db.import_from_json()
            self.db.import_from_json()
        except Exception as e:
            logger.error(f"Rollback failed: {e}")

    def _recover_chapter(self, chapter_num, task_card, synopsis, world_state, min_ch) -> bool:
        max_retries = self.config.get("autonomy", {}).get("chapter_regen_max_retries", 2)
        temps = [0.9, 1.0]
        for i in range(max_retries):
            try:
                self._rollback_world_to(chapter_num - 1)
                novel = self.writer.generate_full_chapter(
                    task_card, synopsis, None, temperature_override=temps[i % len(temps)])
                self._journal_validated_scenes(chapter_num)
                novel = self.writer.polish_chapter(novel, task_card, llm_client=self.polish_router)
                novel = self._ensure_chinese(novel)
                review = self._stage_review(chapter_num, task_card, synopsis, novel, world_state)
                if review["score"] >= min_ch:
                    self.current_novel = novel
                    self._recovered_score = review["score"]
                    return True
            except Exception as e:
                logger.warning(f"Recovery attempt {i+1} failed: {e}")
        self.defects.add(chapter_num, "below_min_ch",
                        f"regen failed after {max_retries} retries (target min_ch={min_ch})")
        return False

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

    def _run_continuity_audit(self, chapter_num):
        try:
            import copy, json
            cur = copy.deepcopy(getattr(self, "current_world_state", None) or {})
            if self._last_audit_snapshot is None:
                self._last_audit_snapshot = cur
                return
            merged = {**cur, "_baseline": self._last_audit_snapshot}
            report = self.auditor.audit_full(merged)
            self._last_audit_snapshot = cur
            path = self.root / "audit" / "continuity_report.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"chapter": chapter_num, **report}, ensure_ascii=False) + "\n")
            if not report["passed"]:
                logger.warning(f"[audit] continuity issues at ch{chapter_num}: {report['realms']}")
        except Exception as e:
            logger.error(f"[audit] failed: {e}")

    def _novel_string(self, novel=None):
        """Return the plain-text content of a chapter, whether it is stored as a
        str or as a lightweight novel object exposing a `.content` attribute."""
        n = self.current_novel if novel is None else novel
        if n is None:
            return ""
        if hasattr(n, "content"):
            return n.content
        return n if isinstance(n, str) else str(n)

    def _ensure_chinese(self, novel):
        """Deterministic safety net: the small writer model occasionally leaks English
        (e.g. 'Scene') despite the prompt. If Latin script fragments remain, rewrite
        them into fluent Chinese via the generation LLM before review/commit."""
        import re
        text = self._novel_string(novel)
        if not re.search(r"[A-Za-z]{4,}", text or ""):
            return novel
        prompt = ("以下中文网络小说正文里混入了英文/拉丁字母片段（如 Scene、Chapter、steady 等）。"
                  "请将它们全部改写为通顺、符合语境的中文（Scene→场景，Chapter→章），"
                  "保持剧情、人物与文风不变。只输出修正后的完整正文，不要任何解释或注释：\n\n" + text)
        try:
            resp = self.llm.chat_completion(
                [{"role": "system",
                  "content": "你是将中英混杂的小说文本纯中文化的资深编辑，只输出修正后的全文。"},
                 {"role": "user", "content": prompt}],
                max_tokens=min(len(text) + 1000, 16000))
            new_text = (resp.get("content") or text).strip()
            if hasattr(novel, "content"):
                novel.content = new_text
                return novel
            return new_text
        except Exception as e:
            logger.warning(f"de-anglicize failed: {e}")
            return novel

    def _forbidden_violations(self, novel, review_text=""):
        text = getattr(novel, "content", None)
        if text is None:
            text = novel if isinstance(novel, str) else str(novel)
        out = []
        out.extend(self.forbidden.scan(text))
        if review_text:
            out.extend(self.forbidden.scan_review(review_text))
        return out

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

    def _run_chapters_gated(self, start_chapter, total_chapters, chapter_fn, on_done=None):
        """Run chapter generation with optional pipeline overlap.

        When model_router.max_parallel_chapters <= 1 chapters run strictly
        sequentially. Otherwise up to max_parallel_chapters chapters run concurrently
        (gated by the executor); on_done(chapter_num, result) is invoked as each chapter
        completes and may return False to stop the run. Results are returned in chapter
        order. NOTE: the orchestrator shares per-chapter mutable state, so raise
        max_parallel_chapters only if you accept the (guarded) concurrency trade-off.
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed
        para = max(1, int(self.config.get("model_router", {}).get("max_parallel_chapters", 1)))
        if para <= 1:
            results = []
            for ch in range(start_chapter, total_chapters + 1):
                res = chapter_fn(ch)
                results.append(res)
                if on_done is not None and on_done(ch, res) is False:
                    break
            return results

        with ThreadPoolExecutor(max_workers=para) as ex:
            futures = {ex.submit(chapter_fn, ch): ch for ch in range(start_chapter, total_chapters + 1)}
            results_map = {}
            for fut in as_completed(futures):
                ch = futures[fut]
                res = fut.result()
                results_map[ch] = res
                if on_done is not None and on_done(ch, res) is False:
                    break
        return [results_map[c] for c in range(start_chapter, total_chapters + 1) if c in results_map]

    def run_mini_test(self, num_chapters: int = 10) -> list[dict]:
        """运行 Mini 测试：生成 N 章。"""
        self.state_machine.current_chapter = 0

        def _chapter(i):
            self.state_machine.current_chapter = i
            return self._run_with_retry(i)

        def _done(i, result):
            # Task 8: continuity audit cadence (non-blocking, autonomous)
            if i % self.audit_interval == 0:
                self._run_continuity_audit(i)
            if not result["success"]:
                logger.error(f"Mini test FAILED at chapter {i}")
                return False
            return True

        return self._run_chapters_gated(1, num_chapters, _chapter, _done)

    # ====== Task 10: remediation loop + terminal termination + production report ======

    def run_remediation_and_finalize(self, task_card, synopsis, world_state, total_chapters=None):
        import json
        max_rounds = self.config.get("autonomy", {}).get("remediation_max_rounds", 1)
        per_ch_max = self.config.get("autonomy", {}).get("remediation_per_chapter_retries", 2)
        pub_line = int(load_quality_policy(self.root)["publication_line"])
        # Q6=A: exactly one bounded remediation round
        for _ in range(max_rounds):
            pending = [d for d in self.defects.pending()]
            if not pending:
                break
            for d in pending:
                ch = d["chapter"]
                for _i in range(per_ch_max):
                    res = self.generate_single_chapter(ch)
                    if res.get("success"):
                        self.defects.mark_known(ch)
                        self._mark_chapter_done(ch)
                        break
        pending = self.defects.pending()
        final_ok = (len(pending) == 0)
        report = {
            "status": "published" if final_ok else "needs_human",
            "total_chapters": total_chapters,
            "pending_defects": len(pending),
            "known_defects": len(self.defects.all()),
            "defects": pending,
        }
        try:
            if final_ok and getattr(self, "current_novel", None) is not None:
                fin = self.reviewer.review_chapter(
                    0, task_card, synopsis, self._novel_string(), world_state or {})
                fs = fin.get("score") or fin.get("total_score")
                report["final_score"] = fs
                if fs is not None and fs < pub_line:
                    report["status"] = "needs_human"
                    report["reason"] = f"final score {fs} < publication_line {pub_line}"
        except Exception as e:
            report["final_review_error"] = str(e)
        path = self.root / "audit" / "production_report.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    def run_full_unattended(self, total_chapters, task_card=None, synopsis=None,
                            world_state=None, start_chapter=1):
        tc = task_card if task_card is not None else self._load_task_card_file()
        sy = synopsis if synopsis is not None else self._load_synopsis_file()
        ws = world_state if world_state is not None else self._load_world_state_file()

        def _done(ch, res):
            if res.get("success"):
                self._mark_chapter_done(ch)
            return True

        self._run_chapters_gated(start_chapter, total_chapters,
                                 self.generate_single_chapter, _done)
        return self.run_remediation_and_finalize(tc, sy, ws, total_chapters)

    def _load_task_card_file(self):
        p = self.root / "task_card.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def _load_synopsis_file(self):
        p = self.root / "synopsis.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def _load_world_state_file(self):
        import json
        p = self.root / "world_state.json"
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    # ====== Task 11: resume from checkpoint ======

    def _resume_state_path(self):
        return self.root / self.config.get("autonomy", {}).get(
            "resume_state_file", "audit/resume_state.json")

    def _mark_chapter_done(self, chapter_num):
        import json
        p = self._resume_state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        done = []
        if p.exists():
            try:
                done = json.loads(p.read_text(encoding="utf-8")).get("done", [])
            except Exception:
                done = []
        if chapter_num not in done:
            done.append(chapter_num)
        p.write_text(json.dumps({"done": done}, ensure_ascii=False), encoding="utf-8")

    def resume_from_chapter(self, total_chapters, task_card=None, synopsis=None,
                            world_state=None):
        p = self._resume_state_path()
        done = []
        if p.exists():
            try:
                done = json.loads(p.read_text(encoding="utf-8")).get("done", [])
            except Exception:
                done = []
        start = (max(done) + 1) if done else 1
        return self.run_full_unattended(total_chapters, task_card=task_card,
                                        synopsis=synopsis, world_state=world_state,
                                        start_chapter=start)

    def run_medium_test(self, num_chapters: int = 70) -> list[dict]:
        """运行中等规模测试：生成 N 章（含滑动窗口审查）。"""

        def _done(i, result):
            # Task 8: continuity audit cadence (non-blocking, autonomous)
            if i % self.audit_interval == 0:
                self._run_continuity_audit(i)

            # 每50章触发滑动窗口审查
            if self.memory.should_trigger_sliding_window(i, window_size=50):
                logger.info(f"Triggering sliding window review at chapter {i}")
                self._run_sliding_window_review(i)

            if not result["success"]:
                logger.error(f"Medium test FAILED at chapter {i}")
                return False
            return True

        return self._run_chapters_gated(1, num_chapters, self._run_with_retry, _done)

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

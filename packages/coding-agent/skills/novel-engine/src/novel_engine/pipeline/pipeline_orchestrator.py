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
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from novel_engine.core.state_machine import StateMachine, ChapterPhase
from novel_engine.core.checkpoint import CheckpointManager
from novel_engine.core.quality_policy import load_quality_policy, is_blocking, derive_scene_targets
from novel_engine.agents.world_simulator import WorldSimulator
from novel_engine.agents.chapter_director import ChapterDirector, merge_thin_scene_blueprints
from novel_engine.agents.writer_agent import SynopsisAgent, WriterAgent
from novel_engine.agents.scene_schema import SceneOutput, extract_beats_fallback, validate_scene_text, detect_scene_overlap, build_scene_prompt, validate_beats_covered
from novel_engine.core.errors import (
    SceneUnrecoverableError, ChapterResampleRequiredError, ChapterQualityGapError,
)
from novel_engine.pipeline.chapter_journal import (
    append_scene, completed_scene_ids, load_scenes,
    load_authoritative_scenes, authoritative_completed_scene_ids,
    snapshot_journal, restore_journal,
)
from novel_engine.pipeline.event_ledger import (
    append_chapter_events, recent_event_block,
    append_end_state, latest_end_state, end_state_anchor_block,
)
from novel_engine.pipeline.boundary_guard import (
    stage1_score, scene_overlap_scores,
    build_stage2_prompt, parse_stage2_verdict,
)
from novel_engine.quality.degeneration import find_self_repetition, is_near_empty
from novel_engine.quality.timeline_gate import detect_timeline_jump, anchor_fix_directive
from novel_engine.quality.continuity_gate import (
    normalize_sequence, build_specs, detect_inversions, continuity_fix_directive,
    extract_prior_acquired_entities,
)
from novel_engine.quality.scope_gate import (
    detect_scope_violations, scope_fix_directive, _extract_card_hard_terms,
excise_dawn_overrun,
)
from novel_engine.quality.temporal_continuity import excise_from_text as excise_temporal_violations
from novel_engine.quality.review_votes import (
    should_run_extra_reviews, aggregate as aggregate_votes,
)
from novel_engine.quality import review_hybrid
from novel_engine.pipeline.phase_cache import PhaseCache, content_key, model_fingerprint, PROMPT_VERSIONS
from novel_engine.agents.reviewer_agent import ReviewerAgent, DIM_MAX
from novel_engine.agents.pacing_advisor import PacingAdvisor
from novel_engine.core.memory_manager import MemoryManager
from novel_engine.core.llm_client import LLMClient, call_llm, get_call_log, reset_call_log
from novel_engine.core.call_metrics import snapshot as get_metrics_snapshot, load_pricing
from novel_engine.pipeline.chapter_status import set_status, COMMITTED, HALTED, get_status
from novel_engine.core.llm_failover import FailoverLLMClient
from novel_engine.core.model_router import ModelRouter
from novel_engine.quality.defects_store import DefectsStore
from novel_engine.quality.outline_coverage_gate import validate_outline_coverage
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


def _beat_to_str(b) -> str:
    """Coerce one task-card beat to a plain string (models sometimes emit objects)."""
    if isinstance(b, str):
        return b.strip()
    if isinstance(b, dict):
        for k in ("beat", "desc", "content", "summary", "text", "title"):
            v = b.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        try:
            return json.dumps(b, ensure_ascii=False)
        except Exception:
            return ""
    if b is None:
        return ""
    return str(b).strip()


def _is_coherent_short(obj, need_beats: int) -> bool:
    """结构化合法但篇幅极短的“连贯短文”（真机：flash 会在合法 JSON/beats 全覆盖下只写
    约120字就 finish=stop）。这类不是空/乱码/重复，应走中性参数重生与有界扩写，而不是
    近空 penalty（实测 penalty 反而把它打成0字）。

    判据（同时满足）：structured 合法、非 length 截断、beats_covered 已覆盖全部 beat、
    无占位/自重复、含≥40个中文字且中文占比≥0.5。
    """
    if not getattr(obj, "structured", False):
        return False
    if str(getattr(obj, "finish_reason", "") or "") == "length":
        return False
    _covered = [x for x in (getattr(obj, "beats_covered", []) or []) if str(x).strip()]
    if int(need_beats or 0) > 0 and len(_covered) < int(need_beats):
        return False
    _text = getattr(obj, "scene_text", "") or ""
    if any(m in _text for m in (
            "待补充", "此处省略", "（略）", "(略)", "TODO", "【待写", "此处留白", "暂缺")):
        return False
    if find_self_repetition(_text)[0]:
        return False
    _cjk = sum(1 for c in _text if "\u4e00" <= c <= "\u9fff")
    if _cjk < 40 or _cjk / max(1, len(_text)) < 0.5:
        return False
    return True


def _normalize_blueprint_beats(task_card: dict) -> None:
    """Canonicalize every blueprint's beats + CC round-8 temporal fields."""
    for idx, bp in enumerate(task_card.get("scene_blueprints") or []):
        if not isinstance(bp, dict):
            continue
        bp["beats"] = [s for s in (_beat_to_str(b) for b in (bp.get("beats") or [])) if s]
        # CC round-8 P0-1：时序字段规范化（缺失安全回退，不因此判任务卡失败）
        _sid = int(bp.get("scene_num", idx + 1) or (idx + 1))
        try:
            _seq = int(bp.get("sequence_index"))
            if _seq <= 0:
                _seq = _sid
        except (TypeError, ValueError):
            _seq = _sid
        bp["sequence_index"] = _seq
        bp["narrative_time"] = str(bp.get("narrative_time", "") or "").strip()
        _states = bp.get("do_not_depict_before")
        bp["do_not_depict_before"] = (
            [str(x).strip() for x in _states if str(x).strip()]
            if isinstance(_states, list) else []
        )
        _kw = bp.get("do_not_depict_keywords")
        _groups: list[list[str]] = []
        if isinstance(_kw, list):
            for _g in _kw:
                if isinstance(_g, list):
                    _terms = sorted({str(x).strip() for x in _g if str(x).strip()})
                    if len(_terms) >= 2:
                        _groups.append(_terms)
        bp["do_not_depict_keywords"] = _groups


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
        if llm_client is not None:
            # Test mode: use injected mock client for ALL routers
            self.scene_router = llm_client
            self.polish_router = llm_client
            self.outline_router = llm_client
            self.review_router = llm_client
            self.refine_router = llm_client
        else:
            self.scene_router = ModelRouter("scenes", self.root)
            self.polish_router = ModelRouter("polish", self.root)
            self.outline_router = ModelRouter("outline", self.root)
            self.review_router = ModelRouter("review", self.root)
            # CC round-27 Phase2：文字精修池（有界扩写/length-floor 补写/CC25 文学性重写），
            # 配置 phases.refine 指向 agnes-2.5-pro；与大纲相位解耦，避免牵连 outline/director。
            # refine 为可选相位：精简/旧 profile（如测试、备用供应商）未定义时回退复用 polish_router。
            try:
                self.refine_router = ModelRouter("refine", self.root)
            except Exception as _refine_miss:
                logger.info(f"phase 'refine' absent, reuse polish router: {_refine_miss}")
                self.refine_router = self.polish_router

        if llm_client is not None:
            self.llm = llm_client
        else:
            self.llm = self.outline_router  # default for pure-text calls (director/synopsis also get dedicated routers below)

        self.state_machine = StateMachine(self.root)
        self.checkpoint_mgr = CheckpointManager(self.root)
        # CC P0: content-addressed disk cache (director post-validation / reviewer by final text)
        self._phase_cache = PhaseCache(self.root)
        # reviewer 缓存只在“每章每进程首次评审”读取：同进程修复循环允许对新结果再评审，
        # 跨进程(supervisor 重启)重跑同稿时才命中，消除 infra 重复计费。
        self._review_read_chapters: set = set()
        # CC round-7: 跨章边界硬门（assembly 后判定，未解决则并入确定性硬门阻断提交）
        self._boundary_hard: list[str] = []
        # CC28 批B 3b：章内相邻场同一现场近重复重演硬门（跨场校验后判定，并入确定性硬门）
        self._reprise_hard: list[str] = []
        # CC round-7 P0-1: 整章 rewrite 默认下线（实测会降分），只保留场景定点重生
        self._allow_whole_rewrite = bool(
            (self.config.get("pipeline", {}) or {}).get("allow_whole_chapter_rewrite", False))
        self.simulator = WorldSimulator(self.root)
        if llm_client is not None:
            # Test mode: use injected mock client for director and synopsis too
            self.director = ChapterDirector(self.root, llm_client=llm_client)
            self.synopsis_agent = SynopsisAgent(llm_client=llm_client)
        else:
            self.director = ChapterDirector(self.root, llm_client=ModelRouter("director", self.root))
            self.synopsis_agent = SynopsisAgent(llm_client=ModelRouter("synopsis", self.root))

        # Instantiate StateDB
        db_dir = self.root / "runtime"
        db_dir.mkdir(parents=True, exist_ok=True)
        self.db = StateDB(db_path=str(db_dir / "state.db"), project_root=self.root)

        # Instantiate or load SessionTree
        self.session_tree_path = self.root / "runtime" / "session_tree.json"
        self._load_session_tree()

        self.writer = WriterAgent(llm_client=self.scene_router)
        # CC30（DS Q1/Q2/Q3）：仅真机开启按场 flash->pro 故障转移。真机判据用
        # production_runner 设置的 NOVEL_ENGINE_REAL_LANG_ENFORCE=1，并排除 MockLLMClient；
        # 注入的是真实 client 时为 pro 单独建 refine 池（agnes-2.5-pro），mock/离线零影响。
        _real30 = os.environ.get("NOVEL_ENGINE_REAL_LANG_ENFORCE") == "1"
        _is_mock30 = llm_client is not None and type(llm_client).__name__ == "MockLLMClient"
        if _real30 and not _is_mock30:
            try:
                _pro30 = self.refine_router if llm_client is None else ModelRouter("refine", self.root)
                self.writer.set_pro_failover(True, client=_pro30)
            except Exception as _e30:
                logger.warning(f"CC30 pro failover not armed: {_e30}")
        # CC round-12：显式给每个 router 持有的 client 下发 phase（幂等保险），使
        # LLMClient 的空/极短正文退化门在场景等阶段按 phase 生效（含定点重生路径）。
        for _rname, _router in (("scenes", self.scene_router), ("polish", self.polish_router),
                                ("outline", self.outline_router), ("review", self.review_router),
                                ("refine", self.refine_router)):
            for _c in getattr(_router, "providers", {}).values():
                if _c is not None and hasattr(_c, "phase"):
                    _c.phase = _rname
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

            # round100: 时间线锚点声明+连续性校验（task_card 就绪后，非阻塞）
            try:
                from novel_engine.timeline.timeline_anchors import save_anchor, validate_continuity, get_prev_anchor
                _ts = str(task_card.get("time_setting", ""))
                _anchor = {
                    "chapter_id": chapter_num,
                    "in_world_datetime_start": _ts,
                    "in_world_datetime_end": "",
                    "elapsed_since_prev": _ts if _ts else "数日内",
                    "jump": ("年" in _ts) if _ts else False,
                    "character_age_snapshot": {},
                }
                _ok, _errs = validate_continuity(_anchor, get_prev_anchor(chapter_num))
                if not _ok:
                    logger.warning(f"[timeline] ch{chapter_num} continuity fail: {_errs}")
                save_anchor(_anchor)
                logger.info(f"Timeline anchor saved for chapter {chapter_num} (elapsed={_anchor['elapsed_since_prev']})")
            except Exception:
                logger.exception(f"[timeline] anchor save failed ch{chapter_num} (non-blocking)")
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
        except (ChapterResampleRequiredError, SceneUnrecoverableError) as ce:
            # CC round-7 P0-2：整章近空簇（≥2）或单场景两救仍真退化（近空/空/乱码，
            # 非连贯短文）都判“质量类整章重采”：不进 NEEDS_HUMAN、不在本章用同一任务卡
            # 烧重试；交 runner HALT→看门狗，绕过 director 缓存带新 end_state/timeline
            # 约束重新规划，避免复用同一张坏任务卡造成死循环。
            _ids = list(getattr(ce, "scene_ids", None) or [])
            if not _ids and getattr(ce, "scene_id", None) is not None:
                _ids = [ce.scene_id]
            logger.warning(f"WRITE REPLAN ch{task_card.get('chapter_num')}: {ce}")
            result["errors"].append(f"WRITE_REPLAN: {ce}")
            result["quality_replan"] = True
            result["replan_scene_ids"] = _ids
            result["replan_reason"] = getattr(ce, "replan", None) or "scene_near_empty_cluster"
            if isinstance(ce, ChapterQualityGapError):  # CC20：质量留空，不整批 HALT
                result["quality_gap_continue"] = True
                result["gap_kind"] = getattr(ce, "gap_kind", None) or "quality"
                result["gap_violations"] = list(getattr(ce, "violations", None) or [])
            return result
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
            total_target = self._global_target  # 字数硬门锚定全局章节目标（模型 blueprint 字数和会漂移）
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

            # CC round-8 P0-3：三评极差>15 → 评审本身不可靠，无论中位数是否过线都不自动提交，
            # 落 draft 强制人工复核（不做整章重采，重采无法消除评审噪声）。
            if stage_review.get("review_unstable"):
                logger.error(
                    f"Chapter {chapter_num} review highly unstable (median-of-3 range>15, "
                    f"score={score}) -> force human review, no commit")
                try:
                    _dp = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                    _dp.parent.mkdir(parents=True, exist_ok=True)
                    _dp.write_text(self._novel_string(), encoding="utf-8")
                except Exception as _de:
                    logger.warning(f"save unstable draft failed: {_de}")
                result["success"] = False
                result["published"] = False
                result["score"] = score
                result["review_unstable"] = True
                result["pending_human_review"] = True
                result["human_review_note"] = (
                    f"score={score} 三评极差>15，评审极不稳定，强制人工复核（不自动重采）")
                self._flag_for_human(chapter_num, score, "review highly unstable (median-of-3 range>15)")
                return result

            if verdict == "pass":
                result["success"] = True
                logger.info(f"Chapter {chapter_num} PASSED (score={score})")
            elif verdict == "fix":
                orig_novel = self.current_novel
                orig_draft = getattr(self, "_draft_novel", orig_novel)
                pre_fix_score = score
                publication_line = int(load_quality_policy(self.root)["publication_line"])
                _soft_line = int(load_quality_policy(self.root).get("soft_publication_line", publication_line - 3))
                min_ch = publication_line
                # CC E 包：整章级 fix 最多 2 轮；单场景定点重生另有每场景 ≤2 次独立预算
                max_fix = int(self.config.get("pipeline", {}).get("max_chapter_fix_rounds", 2))
                current = orig_novel
                current_draft = orig_draft
                best = (pre_fix_score, current, current_draft)
                # CC28 批B：把初始候选（修复前）与当前 journal 事实态绑定。各轮修复都会就地
                # 覆写 journal；最终采纳 best 时必须把 journal 一并原子回滚到该快照，否则
                # 字符串层回滚了、journal 仍是劣化轮的内容，后续从 journal 组装/发布即成劣稿。
                _best_journal_snapshot = snapshot_journal(self.root, chapter_num)
                # CC28 批B：硬门全绿候选 (score, novel, draft, journal_snapshot)，无则 None。
                best_green = None
                det_issues_pre = getattr(self, "_last_deterministic_issues", [])
                if det_issues_pre:
                    logger.warning(f"Deterministic gate has issues pre-fix: {det_issues_pre} → force patch/rewrite")
                try:
                    # frozen 任务卡在 patch / rewrite 两条分支都会用到，循环外无条件绑定，
                    # 避免定点修复返回 None 改走 rewrite 分支时 frozen 未绑定引发 UnboundLocalError
                    frozen = self._frozen_task_cards.get(chapter_num, task_card)
                    no_improve = 0
                    for _ in range(max_fix):
                        staged = self._stage_review(chapter_num, task_card, synopsis, current, world_state)
                        s = staged["score"]
                        result["score"] = s
                        _fix_policy = load_quality_policy(self.root)
                        has_high = any(_review_issue_is_blocking(_fix_policy, iss) for iss in (staged["review"].get("issues") or []))
                        high_list = [f"{iss.get('dimension')}/{iss.get('severity')}:{iss.get('description','')[:60]}" for iss in (staged["review"].get("issues") or []) if _review_issue_is_blocking(_fix_policy, iss)]
                        det = self._deterministic_quality_gate(current, task_card)
                        soft = det.get("soft_issues", [])
                        prev_best = best[0]
                        if s > best[0]:
                            best = (s, current, current_draft)
                            # 当前分数 s 评审的是 current，其内容正是上一轮修复回写后的 journal；
                            # 此刻捕获 journal 即把“最佳候选”与其事实态绑定。
                            _best_journal_snapshot = snapshot_journal(self.root, chapter_num)
                            no_improve = 0
                        else:
                            no_improve += 1
                        # CC28 批B：单独追踪“确定性硬门全绿且无 high”的候选。采纳时优先于
                        # 分更高但带硬伤的候选（r41 曾出现更高分稿带 latin_leak 被终检阻断）。
                        if det["passed"] and not has_high:
                            if best_green is None or s > best_green[0]:
                                best_green = (s, current, current_draft,
                                              snapshot_journal(self.root, chapter_num))
                        # CC round-14 P0-3：确定性门全过+无high 时，>=88 正常过；85-87.9 灰带也放行（打标人工抽读）
                        _gray_ok = (_soft_line <= s < min_ch) and not has_high and det["passed"]
                        if s >= min_ch:
                            if not has_high and det["passed"]:
                                if soft:
                                    logger.info(f"Score {s} ≥ {min_ch} soft issues (不阻断): {soft}")
                                break
                            else:
                                logger.warning(f"Score {s} ≥ {min_ch} but blocked → high={high_list} det_hard={det['issues']} det_soft={soft} → continue fix")
                        elif _gray_ok:
                            logger.warning(f"Gray-band release ch{chapter_num}: score {s} in [{_soft_line},{min_ch}) + gates pass + no-high → release to novel (flagged for human spot-check) soft={soft}")
                            result["gray_band_release"] = True
                            result["gray_band_score"] = s
                            self._flag_for_human(chapter_num, s, f"gray-band release {s}: deterministic gates passed, no high issue, please spot-read")
                            break
                        # 3 轮不超 best 即提前终止，避免单章空转 1.5h
                        if no_improve >= 2 and _ >= 2:
                            logger.warning(f"Fix loop no improve for {no_improve} rounds (best {best[0]}), early stop")
                            break
                        if _ > 0 and s <= prev_best:
                            # 保留原逻辑作为兜底
                            if no_improve >= 1:
                                break
                        # 优先场景级增量缝合（基于 draft 带标记文本，避免 purified 找不到 marker）
                        # CC round-25 P0-2：E-loop 逐场定点只处理可场景归因的结构性维度；
                        # hook/style/innovation 三维从补丁评审中剔除，交给下方整章一次性文学性重写。
                        try:
                            from novel_engine.agents.literary_pass import (
                                strip_literary_from_review as _strip_lit25,
                                literary_weak as _lit_weak25)
                            _review_for_patch = _strip_lit25(staged["review"])
                        except Exception:
                            _review_for_patch = staged["review"]
                            _lit_weak25 = lambda _r: False  # noqa: E731
                        patched_draft = self._patch_weak_scenes(current_draft, _review_for_patch, task_card, synopsis,
                                                              chapter_num=chapter_num)
                        _cc25_fixed = False  # CC25：本轮结构补丁或文学性重写任一落地即统一重评审
                        frozen = self._frozen_task_cards.get(chapter_num, task_card)
                        if patched_draft is not None and patched_draft != current_draft and len(patched_draft) >= len(current_draft) // 2:
                            # 缝合后需重新净化并强制字数
                            patched_purified = purify_novel_for_publish(patched_draft, chapter_num=chapter_num)
                            # 强制字数（用冻结目标）
                            total = sum(self._bpt(bp) for bp in (frozen.get("scene_blueprints") or []))
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
                            _cc25_fixed = True
                        # CC round-25 P0-2：结构补丁与文学性重写在同一轮【叠加】执行——
                        # 结构补丁负责 pacing/retention/plot/cliff 等可场景归因维度（已回写 journal），
                        # 文学性 pass 紧接着针对 hook/style/innovation 在【最新 journal】上做整章一次性
                        # 场末/措辞重写；避免"结构补丁一应用就 continue"把三维修复饿死（r30 实测该缺陷）。
                        _lit_used25 = getattr(self, "_literary_pass_used", None)
                        if _lit_used25 is None:
                            _lit_used25 = set()
                            self._literary_pass_used = _lit_used25
                        if _lit_weak25(staged["review"]) and chapter_num not in _lit_used25:
                            _lit_res25 = self._cc25_literary_rewrite(
                                current, staged["review"], task_card, synopsis, chapter_num)
                            if _lit_res25 is not None:
                                _lit_used25.add(chapter_num)
                                current, current_draft = _lit_res25
                                self.current_novel = current
                                self._draft_novel = current_draft
                                gate_after = self._deterministic_quality_gate(current, frozen)
                                self._last_deterministic_issues = gate_after["issues"]
                                _cc25_fixed = True
                            else:
                                logger.info(f"ch{chapter_num}: CC25 literary pass produced no gain")
                        if _cc25_fixed:
                            continue
                        # CC round-7 P0-1：整章 rewrite 实测会降分（84.2→65.8），默认下线；
                        # 只保留 E 场景定点重生，patch 走不通即结束修复循环 → 终态隔离/HALT。
                        if not self._allow_whole_rewrite:
                            logger.info(
                                f"ch{chapter_num}: whole-chapter rewrite disabled "
                                "(allow_whole_chapter_rewrite=false); end fix loop → terminal routing")
                            break
                        rewritten = self._rewrite_weak_dimensions(current, staged["review"])
                        if not rewritten or len(rewritten) < len(current) // 2:
                            break
                        # ── 按场景标记切分，按 scene_id 升序写入 journal，避免 draft/journal 双本本漂移
                        _scenes = []
                        # 优先 ※ 分割，其次 【场景N】 两种格式
                        import re as _re
                        # 使用 capturing group 的 split：保留标记在结果中，
                        # parts[0] 为标记前内容（跳过），parts[1] 为标记1，parts[2] 为标记1后文本，parts[3] 为标记2，...
                        parts = _re.split(r'(※|【场景\d+】)', rewritten)
                        # 收集所有（标记、文本）对，每个标记后的一段为一个场景
                        i = 1  # 跳过 parts[0]（标记前内容）
                        while i + 1 < len(parts):
                            marker = parts[i].strip()       # 如 "※3" 或 "【场景3】"
                            text = parts[i + 1].strip()     # 如 "该场景的正文..."
                            # 从标记中提取 scene_id：※数字 或 【场景N】
                            m = _re.search(r'※\s*(\d+)|【场景(\d+)\]', marker)
                            if m:
                                sid = int(m.group(1) or m.group(2))
                            else:
                                # 无标记数字：按出现顺序 1..N 映射（从已有 journal 最大值 + 1 续）
                                existing = load_scenes(self.root, chapter_num)
                                sid = (max((s["scene_id"] for s in existing), default=0) + 1) if existing else 1
                            _scenes.append({"scene_id": sid, "scene_text": text})
                            i += 2  # 步进到下一个标记
                        # 若以文本结尾且无最后标记，视为无标记场景（按顺序接续）
                        if i <= len(parts) - 1:
                            trailing = parts[i].strip()
                            if trailing and not _re.match(r'※|【场景\d+]', trailing):
                                existing = load_scenes(self.root, chapter_num)
                                sid = (max((s["scene_id"] for s in existing), default=0) + 1) if existing else len(_scenes) + 1
                                _scenes.append({"scene_id": sid, "scene_text": trailing})
                        # 写入 journal：upsert 语义（同一 scene_id 只保留最新记录）
                        # 采用现有 chapter_journal 机制：载入现有，覆写/新增后按 scene_id 升序整文件写入
                        from novel_engine.pipeline.chapter_journal import append_scene, load_scenes as _load_scenes
                        existing_scenes = _load_scenes(self.root, chapter_num)
                        # 建立 id→scene 的快速查找
                        _by_id = {s["scene_id"]: s for s in existing_scenes}
                        # 覆写或新增每个 scene
                        for s in _scenes:
                            if s["scene_id"] in _by_id:
                                _by_id[s["scene_id"]]["scene_text"] = s["scene_text"]
                            else:
                                existing_scenes.append(s)
                                _by_id[s["scene_id"]] = s
                        # 按 scene_id 升序排序后写入（确保顺序确定）
                        existing_scenes.sort(key=lambda s: s["scene_id"])
                        journal_path = __import__('pathlib').Path(self.root) / "chapters" / "draft" / f"chapter_{chapter_num}_partial.jsonl"
                        journal_path.parent.mkdir(parents=True, exist_ok=True)
                        with open(journal_path, "w", encoding="utf-8") as f:
                            for s in existing_scenes:
                                f.write(json.dumps({"scene_id": s["scene_id"], "scene_text": s["scene_text"],
                                                    "hook": s.get("hook", ""), "beats": list(s.get("beats", []) or []),
                                                    "entities_json": s.get("entities_json", "")}, ensure_ascii=False) + "\n")
                        # 5) 从 journal 按 scene_id 升序重新拼接 current（※ 分隔），不再使用 rewritten 原文作为后续引用
                        ordered = existing_scenes  # 已是升序
                        current = "※".join([s["scene_text"] for s in ordered])
                        current_draft = current  # 重写结果同步为 draft
                        self.current_novel = current
                        self._draft_novel = current_draft
                        # Journal write-back 已在上文完成（upsert 语义），无需额外同步
                        gate_after = self._deterministic_quality_gate(current, frozen)
                        self._last_deterministic_issues = gate_after["issues"]
                    # CC28 批B：优先采纳“硬门全绿”候选；没有任何全绿候选时才退回最高分候选
                    # （供人审队列），并保持其分数为最终分。
                    if best_green is not None:
                        best_score, best_novel, best_draft, _best_journal_snapshot = best_green
                        if best_score < best[0]:
                            logger.warning(
                                f"ch{chapter_num}: adopt gate-green candidate {best_score} over "
                                f"higher-score blocked candidate {best[0]}")
                    else:
                        best_score, best_novel, best_draft = best
                    self.current_novel = best_novel
                    self._draft_novel = best_draft
                    result["score"] = best_score
                    # CC28 批B：采纳 best 时把 journal 原子恢复到该候选的事实态快照，
                    # 必须先于任何后续从 journal 的读取（post-fix topup/终检/组装/发布）。
                    if restore_journal(self.root, chapter_num, _best_journal_snapshot):
                        logger.info(f"ch{chapter_num}: journal atomically rolled back to best "
                                    f"candidate snapshot (score={best_score})")
                    else:
                        logger.error(f"ch{chapter_num}: journal rollback to best snapshot FAILED "
                                     f"(score={best_score}); journal may diverge from chosen text")
                    # CC round-18 P0-3：修订后二次长度门（E-loop“先删后补”可能让成稿缩水）
                    try:
                        from novel_engine.quality.post_fix_length import post_fix_length_decision
                        _wp18 = load_quality_policy(self.root)
                        _soft_floor18 = int(_wp18["chapter_target_chars"] * _wp18["min_ratio"])
                        _len18 = post_fix_length_decision(len(best_novel or ""), soft_floor=_soft_floor18)
                        if _len18["status"] == "needs_topup" and not (self.config.get("llm") or {}).get("use_mock"):
                            logger.warning(f"Post-fix length ch{chapter_num}: {_len18['current']} in topup band "
                                           f"(floor {_soft_floor18}, gap {_len18['gap']}) -> bounded descriptive topup")
                            _js18 = load_authoritative_scenes(self.root, chapter_num)  # CC19 Q2
                            if _js18:
                                _sc18 = [SceneOutput(scene_id=int(d["scene_id"]), scene_text=d.get("scene_text", "") or "",
                                                     hook=d.get("hook", "") or "") for d in sorted(_js18, key=lambda x: x["scene_id"])]
                                _frozen18 = self._frozen_task_cards.get(chapter_num, task_card)
                                _to18 = self._apply_length_floor(chapter_num, _frozen18, _sc18, best_novel)
                                if _to18 and _to18 != best_novel and len(_to18) > len(best_novel):
                                    best_novel = _to18
                                    best_draft = _to18
                                    best = (best_score, best_novel, best_draft)
                                    self.current_novel = best_novel
                                    self._draft_novel = best_draft
                                    logger.info(f"Post-fix topup ch{chapter_num}: -> {len(best_novel)} chars")
                        elif _len18["status"] == "severe_shortfall":
                            logger.warning(f"Post-fix length ch{chapter_num}: SEVERE shortfall {_len18['current']} "
                                           f"< topup line {_len18['topup_line']} -> flag human, no large auto-topup")
                            result["severe_shortfall"] = True
                            result["severe_shortfall_chars"] = _len18["current"]
                            self._flag_for_human(chapter_num, best_score,
                                                 f"post-fix severe shortfall {_len18['current']}/{_soft_floor18}; please verify")
                    except Exception as _e18:
                        logger.warning(f"Post-fix length check skipped: {_e18}")
                    _final_det_g = self._deterministic_quality_gate(best_novel, self._frozen_task_cards.get(chapter_num, task_card))
                    _final_pol_g = load_quality_policy(self.root)
                    _final_high_g = any(_review_issue_is_blocking(_final_pol_g, iss) for iss in (staged["review"].get("issues") or []))
                    _soft_line = int(_final_pol_g.get("soft_publication_line", min_ch - 3))
                    _gray_final = (_soft_line <= best_score < min_ch) and not _final_high_g and _final_det_g["passed"]
                    if _gray_final:
                        logger.warning(f"Gray-band final release ch{chapter_num} score {best_score} (gates pass, no-high) → publish to novel, flagged human spot-check")
                        result["gray_band_release"] = True
                        result["gray_band_score"] = best_score
                        self._flag_for_human(chapter_num, best_score, f"gray-band final release {best_score}: spot-read required")
                    if best_score >= min_ch or _gray_final:
                        # 最终仍需校验硬门控；若仍硬阻断则强制发布 best 供人审阅（附 note），不跳过章节
                        final_det = self._deterministic_quality_gate(best_novel, self._frozen_task_cards.get(chapter_num, task_card))
                        _final_policy = load_quality_policy(self.root)
                        final_high = any(_review_issue_is_blocking(_final_policy, iss) for iss in (staged["review"].get("issues") or []))
                        if (final_high or not final_det["passed"]) and not _gray_final:
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
            "normalized_score": review.get("normalized_score", score),
            "max_total": review.get("max_total", sum(DIM_MAX.values())),
            "score_schema": review.get("score_schema", "v2"),
            "verdict": verdict,
            "scores": review.get("scores", {}),
            "praise": review.get("praise", ""),
            "issues": review.get("issues", []),
            "dim_scores": review.get("dim_scores", {}),
        })
        review_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")

        # 阶段6：提交（P0-A2 加闸：仅 publication_line 以上且无 policy 硬阻断且确定性硬门控通过才写最终目录）
        _commit_policy = load_quality_policy(self.root)
        publication_line = int(_commit_policy["publication_line"])
        cur_score = float(result.get("score", score or 0) or 0)
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
        # CC30（DS Q5）：真机提交前清洗混入正文的英文脚手架字段词（id/beats/covered 等）。
        # 保守：只清带 JSON 上下文/复合词/同分句>=2 的字段词，白名单与普通英文不碰；清洗后
        # 由紧随的 final_det 重跑长度/密度/拉丁/beats 门；整段全字段词->硬块走既有隔离 gap。
        _scaffold_rollback30 = False
        if not bool((self.config.get("llm") or {}).get("use_mock")):
            try:
                from novel_engine.quality.scaffold_scrub import scrub_scaffold_latin
                _sc30 = scrub_scaffold_latin(final_text)
                if _sc30["status"] == "scrubbed":
                    final_text = _sc30["text"]
                    self.current_novel = final_text
                    logger.warning(f"ch{chapter_num} scaffold-latin scrub removed "
                                   f"{len(_sc30['removed_tokens'])} token(s): {_sc30['removed_tokens'][:8]}")
                elif _sc30["status"] == "rollback_best":
                    _scaffold_rollback30 = True
                    logger.error(f"ch{chapter_num} scaffold-latin whole-paragraph pollution "
                                 f"({_sc30['removed_tokens'][:8]}) -> hard block + gap-continue")
            except Exception as _e30:
                logger.warning(f"scaffold scrub skipped: {_e30}")
        final_det = self._deterministic_quality_gate(final_text, task_card)
        det_issues = final_det["issues"]
        det_soft = final_det.get("soft_issues", [])
        self._last_deterministic_issues = det_issues
        if _scaffold_rollback30:
            det_issues = det_issues + ["scaffold_latin_whole_paragraph_pollution"]
            self._last_deterministic_issues = det_issues
        # P0-发布前泄漏终检：成品不得含任何脚手架 token（与写盘同源）
        from novel_engine.quality.repetition_detector import verify_no_scaffolding
        leak_issues = verify_no_scaffolding(final_text)
        if leak_issues:
            logger.error(f"Leak check failed for chapter {chapter_num}: {leak_issues}")
            det_issues = det_issues + [f"[泄漏] {x}" for x in leak_issues]
            self._last_deterministic_issues = det_issues
        # CC round-19 Q1：提交前对"即将落盘的这同一份 final_text"做统一 fail-closed 终检
        try:
            _fg19 = self._run_final_precommit_gate(chapter_num, task_card, final_text)
        except Exception as _e19:
            logger.warning(f"Final pre-commit gate skipped due to error: {_e19}")
            _fg19 = {"repaired": False, "hard_blocked": False, "violations": [], "text": final_text}
        if _fg19.get("repaired"):
            final_text = _fg19["text"]
            self.current_novel = final_text
            logger.warning(f"Final pre-commit gate ch{chapter_num}: repaired once and re-verified clean")
        if _fg19.get("hard_blocked"):
            _vd19 = [f"{v.get('kind')}:{v.get('detail')}" for v in _fg19.get("violations", [])]
            try:
                _qdir19 = self.root / "chapters" / "draft" / "failed" / f"chapter_{chapter_num}"
                _qdir19.mkdir(parents=True, exist_ok=True)
                (_qdir19 / "final_gate_reject.txt").write_text(final_text, encoding="utf-8")
            except Exception as _qe19:
                logger.error(f"Failed to quarantine final-gate reject ch{chapter_num}: {_qe19}")
            logger.error(f"FINAL GATE BLOCK ch{chapter_num} score={cur_score}: {_vd19} "
                         f"-> quarantine+human, cursor continues")
            self._flag_for_human(chapter_num, cur_score,
                                 "final pre-commit gate blocked: " + "; ".join(_vd19))
            result["success"] = False
            result["published"] = False
            result["score"] = cur_score
            result["final_gate_blocked"] = True
            result["final_gate_violations"] = _vd19
            return result
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
            # CC round-14 P0-3：灰带（85-87.9）确定性门全过+无high 已在评审阶段判定放行，直接视为可发布
            _gray_commit = bool(result.get("gray_band_release")) and cur_score + 1e-9 >= int(
                _commit_policy.get("soft_publication_line", publication_line - 3))
            if _gray_commit and not leak_issues and not det_issues and not has_high_issue:
                can_publish = True
                verdict = {"publish": True, "reasons": [],
                           "note": f"gray-band release {cur_score}: deterministic gates passed, no high issue (human spot-check)"}
                logger.warning(f"Chapter {chapter_num} GRAY-BAND COMMIT score={cur_score} → novel (flagged human spot-read)")
            else:
                from novel_engine.pipeline.quality_gate import evaluate_publish
                verdict = evaluate_publish(score=cur_score, reviewer_issues=review.get("issues", []),
                                           det_hard=det_issues, leak=leak_issues, violations=violations, policy=_commit_policy,
                                           dim_scores=review.get("dim_scores"), total_score=cur_score)
                can_publish = verdict["publish"]
            # CC28/批D：真机分层自动提交（real-only，mock/离线保持旧 88 线行为保护回归）。
            # 仅当非提交原因【只剩聚合总分<publication_line】（无硬门/high/泄漏/forbidden/维度地板）
            # 时，按 CC24 混合分分层：>=85 免审提交，82-85 硬门绿提交+按章号抽检打标，<82 不提交。
            if (not can_publish) and (not bool((self.config.get("llm") or {}).get("use_mock"))):
                try:
                    _block_forbidden28 = bool(violations) and any(
                        _forbidden_violation_is_blocking(_commit_policy, _v) for _v in violations)
                    _nonscore_reasons28 = [
                        _r for _r in (verdict.get("reasons", []) or [])
                        if not (isinstance(_r, str) and _r.startswith("score<"))]
                    if (not leak_issues) and (not det_issues) and (not has_high_issue) \
                            and (not _block_forbidden28) and (not _nonscore_reasons28):
                        from novel_engine.quality import publish_router as _pr28
                        _tier28 = _pr28.decide_publish_tier(cur_score, True, chapter_num)
                        if _tier28.get("auto_submit"):
                            can_publish = True
                            result["auto_submit_tier"] = _tier28["tier"]
                            result["sample_audit_flag"] = bool(_tier28.get("needs_manual_audit"))
                            logger.warning(
                                f"Chapter {chapter_num} AUTO-SUBMIT tier={_tier28['tier']} "
                                f"score={cur_score} hard-green -> novel "
                                f"(sample_audit={result['sample_audit_flag']})")
                except Exception as _e28:
                    logger.warning(f"publish_router override skipped: {_e28}")
        if has_high_issue and not can_publish:
            logger.warning(f"Chapter {chapter_num} has high/block issue → force non-publish (score={cur_score} high={high_list})")
        if det_issues and not can_publish:
            logger.warning(f"Chapter {chapter_num} deterministic hard gate failed → force non-publish (score={cur_score} det_hard={det_issues} det_soft={det_soft})")
        elif det_soft:
            logger.info(f"Chapter {chapter_num} deterministic soft issues (不阻断): {det_soft}")
        if violations and any(_forbidden_violation_is_blocking(_commit_policy, v) for v in violations) and not can_publish:
            logger.warning(f"Chapter {chapter_num} forbidden policy-hard → force non-publish: {violations}")

        if not can_publish:
            # --- 1a) 分档发布机制 ---
            # ≥88 直接发布 novel/（此处已被 force_best 或硬阻断拦截，不应到达此分支）
            # 82-87 → 人工复核队列：落 draft 且 production_report 标注 pending_human_review，不再叫 force-best
            # <82  → 强制 draft（原 force-best 流程）
            if cur_score >= 88:
                # 高分但维度门槛未过：保留好章落 draft 供人工，不再 reject 空跑
                try:
                    draft_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                    draft_path.parent.mkdir(parents=True, exist_ok=True)
                    draft_path.write_text(self._novel_string(), encoding="utf-8")
                    logger.warning(
                        f"Chapter {chapter_num} score={cur_score}>=88 dim-gate blocked → draft pending_human_review"
                    )
                except Exception as e:
                    logger.error(f"Failed to save high-score draft for chapter {chapter_num}: {e}")
                result["success"] = False
                result["published"] = False
                result["score"] = cur_score
                result["pending_human_review"] = True
                result["human_review_note"] = f"score={cur_score}>=88 dim-gate blocked, saved draft pending human review"
                return result
            elif 82 <= cur_score < 88:
                # 82-87：人工复核队列 - 落 draft 并标记，early return 不进入 novel/ 提交
                draft_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                draft_path.parent.mkdir(parents=True, exist_ok=True)
                draft_path.write_text(self._novel_string(), encoding="utf-8")
                logger.warning(
                    f"Chapter {chapter_num} 82-87 人工复核队列（ score={cur_score}  → draft pending_human_review )"
                )
                result["success"] = False
                result["published"] = False
                result["score"] = cur_score
                result["pending_human_review"] = True  # 新增标记
                result["human_review_note"] = f"score={cur_score} in 82-87 range, queued for human review, not force-best"
                # early return，避免进入下面成功后的 world_state 提交流程
                return result
            else:
                # <82：强制 draft（原逻辑）
                try:
                    draft_path = self.root / "chapters" / "draft" / f"chapter_{chapter_num}.txt"
                    draft_path.parent.mkdir(parents=True, exist_ok=True)
                    draft_path.write_text(self._novel_string(), encoding="utf-8")
                    logger.warning(
                        f"Chapter {chapter_num} 强制 draft（ score={cur_score} < 82 )"
                    )
                except Exception as e:
                    logger.error(f"Failed to save draft for chapter {chapter_num}: {e}")
                result["success"] = False
                result["published"] = False
                result["score"] = cur_score
                self._flag_for_human(chapter_num, cur_score, f"below 82: forced draft, score={cur_score}")
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
            # Mark chapter as committed in status tracking
            set_status(self.root, chapter_num, COMMITTED, score=cur_score)
            # CC P0：仅在原子提交成功后追加跨章事件台账（HALT/隔离章不写，失败不回滚已提交章节）。
            try:
                _n_ev = append_chapter_events(self.root, chapter_num, task_card)
                logger.info(f"Chapter {chapter_num}: appended {_n_ev} event-ledger entries")
            except Exception as _le:
                logger.error(f"event ledger append failed for chapter {chapter_num}: {_le}")
            # CC round-7 P0-3：持久化章末精确停点，供下一章 director 开场锚点
            try:
                append_end_state(self.root, chapter_num, task_card)
            except Exception as _ee:
                logger.warning(f"end_state append failed (non-fatal) for ch{chapter_num}: {_ee}")

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
            # Mark chapter as HALTED on commit failure
            set_status(self.root, chapter_num, HALTED, reason="commit_error")
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

    def _stage_directing(self, chapter_num: int, world_state: dict,
                         bypass_cache: bool | None = None) -> dict:
        """阶段2：章节导演生成任务卡（校验失败自动重试）。

        bypass_cache=True（或环境变量 NOVEL_DIRECTOR_BYPASS_CACHE=1，质量类重规划时由
        runner 设置）时跳过 director 磁盘缓存、带最新 end_state/timeline 约束重新规划；
        infra 类失败重试仍正常读缓存。
        """
        self.state_machine.transition(ChapterPhase.DIRECTING)
        max_attempts = 3
        last_errors: list = []
        # CC round-7 Q6：质量 HALT 重试绕过 director 缓存换规划；infra 重试仍走缓存。
        _bypass = (
            bool(bypass_cache)
            or os.environ.get("NOVEL_DIRECTOR_BYPASS_CACHE") == "1"
            or os.environ.get("NOVEL_DIRECTOR_BYPASS_CACHE_CHAPTER") == str(chapter_num)
        )
        if _bypass:
            logger.info(f"Director cache BYPASS for chapter {chapter_num} (quality replan)")
        # CC P0: director disk cache 仅在首轮(无 feedback)读取；命中也必须通过校验才采用。
        _director_cache_hit = False
        _director_cache_key = None

        def _finalize_blueprints(card: dict) -> dict:
            """结构合法卡的统一收尾：薄场合并 + beat 规范化 + 技法元素轮换。"""
            _bps0 = card.get("scene_blueprints") or []
            _bps1 = merge_thin_scene_blueprints(_bps0, self._global_target)
            if len(_bps1) != len(_bps0):
                logger.info(f"Chapter {chapter_num}: merged thin scene blueprints "
                            f"{len(_bps0)} -> {len(_bps1)}")
            card["scene_blueprints"] = _bps1
            _normalize_blueprint_beats(card)
            try:
                from novel_engine.agents.craft_elements import ensure_scene_craft_elements
                ensure_scene_craft_elements(card)
            except Exception:
                pass
            return card

        def _is_volume_opening(ch: int) -> bool:
            try:
                _vols = (self._director_fixed_context or {}).get("volumes", {})
                _lst = _vols.get("volumes", _vols) if isinstance(_vols, dict) else _vols
                for _v in (_lst or []):
                    _rng = _v.get("chapter_range") or _v.get("range") or []
                    if len(_rng) >= 2 and int(_rng[0]) == int(ch):
                        return True
            except Exception:
                return False
            return False

        def _apply_opening_density(card: dict) -> dict:
            """CC29：真机任务卡开场密度门（mock/离线不拦截）。STRICT 硬违规回灌重生≤2次，
            仍不合格 fail-open（注入 writer 硬约束+打标，不 HALT）；SOFT 仅记录信号/注入。"""
            if bool((self.config.get("llm") or {}).get("use_mock")):
                return card
            try:
                from novel_engine.quality import opening_density as _od
                _vol_open = _is_volume_opening(chapter_num)
                _cur = card
                for _datt in range(_od.DENSITY_REGEN_BUDGET + 1):
                    _assess = _od.assess_opening_density(
                        _cur.get("scene_blueprints") or [], chapter_num, _vol_open)
                    _action = _od.decide_density_action(
                        _assess["level"], bool(_assess["hard_violations"]), _datt)
                    if _action == "clean":
                        if _assess["soft_signals"]:
                            _cur["density_soft_signals"] = _assess["soft_signals"]
                            _cur["_density_scene_constraints"] = _assess["scene_constraints"]
                        return _cur
                    if _action == "regenerate":
                        _fb = ["开场事件密度零LLM硬校验未通过（规划阶段，不让LLM自评），请逐条修正后重出完整任务卡："]
                        for _v in _assess["hard_violations"]:
                            if _v["type"] == "consecutive_interior_only":
                                _fb.append(f"- 场景{_v['scenes']} 连续多场无 external_event（纯内省连场），"
                                           "除至多1个过渡场外每场都要规划可被旁人观察到的外部事件")
                            elif _v["type"] == "duplicate_anchor_no_progression":
                                _fb.append(f"- 相邻场景{_v['scenes']} 地点/时间/人物锚点相同且后场无 "
                                           "irreversible_state_delta，属同一现场重演，必须推进时间或地点并落下不可逆变化")
                            elif _v["type"] == "no_world_anomaly_in_opening":
                                _fb.append("- 第1章前2场至少1场必须给出非空 world_anomaly_signal：在场普通村民"
                                           "也能看到的外部物理异象，只描述现象、不解释成因、不用修炼术语")
                        logger.warning(f"ch{chapter_num} opening-density hard violations "
                                       f"(attempt {_datt + 1}/{_od.DENSITY_REGEN_BUDGET}): "
                                       f"{_assess['hard_violations']} -> regenerate blueprint")
                        _regen = self.director.generate_task_card_cached(
                            chapter_num, self._director_fixed_context, feedback=_fb)
                        if self.director.validate_task_card(_regen, chapter_num):
                            logger.error("opening-density regen produced structurally invalid card; "
                                         "keep previous candidate and fail-open")
                            _action = "fail_open"
                        else:
                            _cur = _finalize_blueprints(_regen)
                            continue
                    # fail_open
                    _cur["density_blueprint_fail_open"] = True
                    _cur["density_soft_signals"] = _assess["soft_signals"]
                    _cur["_density_scene_constraints"] = _assess["scene_constraints"]
                    logger.error(f"ch{chapter_num} opening-density fail-open after {_datt + 1} tries; "
                                 f"constraints injected to writer, hard={_assess['hard_violations']}")
                    return _cur
                return _cur
            except Exception as _ode:
                logger.warning(f"opening density gate skipped: {_ode}")
                return card

        for attempt in range(max_attempts):
            task_card = None
            if attempt == 0 and not last_errors and not _bypass:
                try:
                    _dmodel = model_fingerprint(self.root, "director")
                    _director_cache_key = content_key(
                        {"chapter": chapter_num,
                         "fixed_context": self._director_fixed_context,
                         "recent_events": recent_event_block(self.root, chapter_num),
                         "end_anchor": end_state_anchor_block(self.root, chapter_num)},
                        version=PROMPT_VERSIONS["director"], model=_dmodel)
                    task_card = self._phase_cache.get(chapter_num, "director", _director_cache_key)
                    if task_card is not None:
                        _director_cache_hit = True
                        logger.info(f"Director cache hit for chapter {chapter_num}")
                except Exception as _ce:
                    logger.warning(f"director cache read skipped: {_ce}")
                    task_card = None
            if task_card is None:
                task_card = self.director.generate_task_card_cached(
                    chapter_num, self._director_fixed_context, feedback=(last_errors or None)
                )
            errors = self.director.validate_task_card(task_card, chapter_num)
            if not errors:
                # T4: 大纲任务覆盖校验（mock/离线直接放行）
                # R1: 正确取得上一章事件块（复用 recent_event_block）
                _prior_events_block = ""
                if not bool((self.config.get("llm") or {}).get("use_mock")):
                    try:
                        _prior_events_block = recent_event_block(self.root, chapter_num) or ""
                    except Exception as _pe:
                        logger.warning("recent_event_block failed: %s", _pe)
                    try:
                        _ctx = self.director._build_shared_context(chapter_num)[0]
                        _ch_task = _ctx.get("chapter_outline_task") or ""
                        if _ch_task:
                            # validate_outline_coverage 是纯函数，独立 try 不吞 NameError
                            _cov_passed, _cov_issues = validate_outline_coverage(
                                task_card, _ch_task)
                            if not _cov_passed:
                                _regen_fb = (
                                    "[大纲任务未覆盖] 第%d章大纲核心任务：%s。"
                                    "当前蓝图缺失要素：%s。"
                                    "上一章已写内容（禁止重演）：%s。"
                                    "请重新规划蓝图，确保本章大纲任务关键要素被承载。"
                                    % (chapter_num, _ch_task,
                                       "；".join(_cov_issues[:3]),
                                       _prior_events_block[:300])
                                )
                                last_errors = [_regen_fb]
                                logger.warning(
                                    "ch%d outline coverage fail: %s",
                                    chapter_num, _cov_issues[:2])
                                continue
                    except Exception as _oce:
                        # R1: 仅 coverage 计算失败时 skip；变量/接线错误不吞
                        logger.error("outline coverage check error: %s", _oce)
                task_card = _finalize_blueprints(task_card)
                # CC29：真机开场密度门（STRUCT 合法后；mock/离线直接放行）
                task_card = _apply_opening_density(task_card)
                self.current_outline = task_card
                if attempt == 0 and not _director_cache_hit and _director_cache_key:
                    try:
                        self._phase_cache.set(chapter_num, "director", _director_cache_key, task_card)
                    except Exception:
                        pass
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

    @staticmethod
    def _bpt(bp: dict) -> int:
        """防御 word_count_target 偶发为 list（LLM 畸形输出）。"""
        v = bp.get("word_count_target", 0)
        if isinstance(v, list):
            v = v[0] if v else 0
        try:
            return int(v or 0)
        except Exception:
            return 0

    @staticmethod
    def _structure_fingerprint(text: str, tail: int = 400) -> set:
        """跨章结尾结构指纹：提取结尾段场景母题，用于检测章节收尾同构。"""
        tail_text = text[-tail:]
        marks = ["夜", "灯", "静", "沉默", "看", "睡", "风", "光", "黑暗", "影子", "呼吸"]
        return {m for m in marks if m in tail_text}

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
        target = sum(self._bpt(bp) for bp in blueprints) or None
        length = detect_length_anomaly(purified, target)
        if length["anomaly"]:
            soft_issues.extend([f"[长度] {x}" for x in length["issues"]])
        # 脚手架残留二次校验（净化后不应再含这些 token）→ 硬
        if any(tok in purified for tok in ["【场景", "※", "（章末钩子", "（注："]):
            issues.append("[净化] 成品仍含脚手架标记")
        # P2-C4 套话黑名单 → 软（仅预警，不阻断发布，-reported in soft）
        cliches = ["死水石子", "未出鞘", "达摩克利斯", "如野草疯长", "石头砸", "深井", "古井", "悬停", "一潭", "枯木"]
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
        # 伏笔台账超期提醒（CC P0#3）
        try:
            _fs_db = self.db.query_active_foreshadows(int(ch_num or 0))
            for _fs in _fs_db:
                _rc = _fs.get("resolve_chapter")
                if _rc and int(_rc) < int(ch_num or 0):
                    soft_issues.append("[伏笔-超期] " + str(_fs.get("id")) + " 计划" + str(_rc) + "章回收仍open")
        except Exception:
            pass
        # CC round-7 P0-3：跨章重演边界门未解决的硬伤在此并入（assembly 阶段判定）
        for _bh in (getattr(self, "_boundary_hard", []) or []):
            if _bh not in issues:
                issues.append(_bh)
        # CC28 批B 3b：章内相邻场重演未解决的硬伤并入
        for _rh in (getattr(self, "_reprise_hard", []) or []):
            if _rh not in issues:
                issues.append(_rh)
        # CC28 批B 3c：同章同角色多称谓裸切（叙述无同指锚点）→ 硬伤
        try:
            from novel_engine.quality.alias_consistency_gate import (
                detect_bare_alias_switch, load_alias_groups)
            _groups3c = load_alias_groups(self.root)
            _alias = detect_bare_alias_switch(purified, groups=_groups3c)
            for _ai in _alias.get("issues", []) or []:
                issues.append(
                    f"[称谓] 同一角色“{_ai['primary']}”在叙述中无锚点裸切称谓 "
                    f"{_ai['used']}（主用“{_ai['dominant']}”→{_ai['switched_to']}），"
                    "需统一主用名或补同指锚点（如“本名…转生后名…”）")
        except Exception as _ae:
            logger.warning(f"alias consistency gate skipped: {_ae}")
        if soft_issues:
            logger.info(f"Deterministic soft issues (不阻断) for ch{ch_num}: {soft_issues}")
        return {"passed": not issues, "issues": issues, "soft_issues": soft_issues, "purified": purified}

    def _assemble_chapter_text(self, scenes) -> str:
        """B2 管道组装：只拼 scene_text，hook 字段保留在 SceneOutput 供 journal/评审引用，不追加进正文。"""
        return "\n\n".join(s.scene_text for s in scenes)

    def _journal_validated_scenes(self, chapter_num: int) -> None:
        """D1 runner-owned journaling：落盘每个验证通过的结构化场景。

        Writer 只产出内存对象，持久化归 runner 层。写失败只记日志，
        不阻断正文流（journal 是可重建的派生状态）。已落盘 id 跳过，
        使章节重试幂等（completed_scene_ids 为集合，重复行无害）。
        """
        try:
            done = authoritative_completed_scene_ids(self.root, chapter_num)  # CC19 Q2: 空记录不算完成
        except Exception:
            done = set()
        rejected_sids: list[int] = []
        for s in (getattr(self.writer, "last_scenes", None) or []):
            if s.scene_id in done:
                continue
            try:
                ok = append_scene(self.root, chapter_num,
                                  {"scene_id": s.scene_id, "scene_text": s.scene_text,
                                   "hook": s.hook, "beats": s.beats})
                # CC28：写入层语言纯度硬闸拒写（整段非中文退化输出）→ 同步从内存剔除，
                # 保持 journal 与 writer.last_scenes 一致；缺场由既有韧性/补场景流程重生。
                if ok is False:
                    rejected_sids.append(int(s.scene_id))
            except Exception as je:
                logger.warning(f"Journal append failed for chapter {chapter_num} "
                               f"scene {getattr(s, 'scene_id', '?')}: {je}")
        if rejected_sids:
            _rs = set(rejected_sids)
            try:
                self.writer.last_scenes = [
                    sc for sc in (getattr(self.writer, "last_scenes", None) or [])
                    if int(getattr(sc, "scene_id", -1)) not in _rs]
            except Exception:
                pass
            logger.error(f"Chapter {chapter_num}: pruned degenerate non-Chinese scenes "
                         f"{sorted(_rs)} from memory+journal; resilience must regenerate them")
    def _write_polish_flags(self, chapter_num: int, scenes: list, flags: list[bool]) -> None:
        """将 polished 标记写入本章 journal/state。

        格式：[{"scene": <scene_id>, "polished": <bool>}]
        原子写入（tmp + os.replace）。
        """
        import os
        from pathlib import Path
        try:
            state_path = Path(self.root) / "chapters" / "state" / f"chapter_{chapter_num}_polish.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = state_path.with_suffix(".tmp")
            data = [{"scene": int(s.scene_id), "polished": bool(f)} for s, f in zip(scenes, flags)]
            content = json.dumps(data, ensure_ascii=False, indent=2)
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(str(tmp_path), str(state_path))
            logger.info(f"Wrote polish flags for chapter {chapter_num}: {sum(flags)}/{len(flags)} polished")
        except Exception as e:
            logger.warning(f"Failed to write polish flags for chapter {chapter_num}: {e}")

    def _load_journal_scenes(self, chapter_num: int) -> list:
        """D1 resume：从 journal 重建已落盘场景（坏行按 corrupt-line 规则跳过，见 chapter_journal.load_scenes）。"""
        # CC19 Q2：同一 scene_id 取最新非空记录，丢弃 len=0/过期重复，保证重建即权威
        scenes = [SceneOutput(d["scene_id"], d["scene_text"], d.get("hook", ""), d.get("beats", []))
                  for d in load_authoritative_scenes(self.root, chapter_num)]
        return scenes

    def _validate_and_regen_scenes(
        self,
        scenes: list,
        task_card: dict,
        chapter_num: int,
    ) -> None:
        """pkg2e: validate each scene, detect cross-scene overlap, regen-violating scenes up to 2x.

        Raises SceneUnrecoverableError if any scene cannot be recovered.
        Does NOT enter the 0.6 expand branch for near-empty scenes (they get regenerated).
        """
        from novel_engine.core.quality_policy import load_quality_policy, derive_scene_targets

        _wp = load_quality_policy(self.root)
        _chapter_target = int(_wp["chapter_target_chars"])
        bps = task_card.get("scene_blueprints", []) or []
        _scene_targets = derive_scene_targets(_chapter_target, len(bps)) if bps else []

        # CC round-15 L0：净化每场初稿里泄漏的脚手架字段（如裸 "C009"），重定句末。
        # 纯规则、零 LLM、不计重试；净化后的文本才参与字数/句末/beat 判定。
        try:
            from novel_engine.quality import scene_resilience as _sr15
            for _sc in scenes:
                _raw = getattr(_sc, "scene_text", "") or ""
                _clean, _leaked = _sr15.strip_leaked_tokens(_raw)
                if _leaked and _clean != _raw:
                    _sc.scene_text = _clean
                    self._chapter_gate_fired = True
                    logger.warning(
                        f"Scene {getattr(_sc, 'scene_id', '?')} ch{chapter_num}: "
                        "stripped leaked scaffolding token(s) at L0")
        except Exception as _se15:
            logger.warning(f"L0 leak-strip skipped: {_se15}")

        # Phase 1: per-scene validation (length/placeholders/degradation).
        # 近空场景判废后有界重生（最多 2 次）；仍不达标直接抛 SceneUnrecoverableError 停机，
        # 绝不放进 0.6 扩写分支去“注水”。

        def _target_for(idx, obj):
            if idx < len(_scene_targets):
                return _scene_targets[idx]
            return _chapter_target // max(1, len(scenes))

        # CC round-25 P0-1：章内救援阶梯重构。初稿近空不再立刻整章重排——先走更便宜的章内层：
        #   L1 既有单场跨温度重试（下方 _attempt 循环，0.7→0.85，1 次）
        #   L2 同任务卡单场"聚焦重写"（只带本场 beats+推进契约+技法，预算 1 次）
        #   L3 单 beat 拆分重写（每场 1 遍，逐 beat 150-300 字拼接）
        #   L4 整章重排：仅当"同批 ≥2 个场景在 L2/L3 耗尽后仍未达标"才判真·近空簇（见文末）。
        # 这里的初稿扫描只用于 P1(a) HTTP 层诊断埋点（区分采样退化 vs 连接/截断），不触发 HALT。
        for _i, _s in enumerate(scenes):
            _bp0 = next(
                (b for b in bps if int(b.get("scene_num", 0) or 0) == int(getattr(_s, "scene_id", 0) or 0)),
                None)
            _need0 = len([b for b in ((_bp0 or {}).get("beats") or []) if b])
            if getattr(_s, "structured", False) and is_near_empty(
                    getattr(_s, "scene_text", "") or "", _target_for(_i, _s)) and not _is_coherent_short(_s, _need0):
                logger.warning(
                    f"NEAR_EMPTY_HTTP ch{chapter_num} scene {getattr(_s, 'scene_id', _i + 1)} "
                    f"len={len(getattr(_s, 'scene_text', '') or '')} target={_target_for(_i, _s)} "
                    f"finish_reason={getattr(_s, 'finish_reason', '') or '?'} "
                    f"latency_ms={getattr(_s, 'latency_ms', 0)} "
                    f"http_signal={getattr(_s, 'http_signal', '') or '?'} "
                    "-> enters L1/L2/L3 in-chapter rescue (no immediate chapter resample)")

        _unrecoverable_ids: list[int] = []  # CC round-15: 真·无法自动修复场景收集
        for i, s in enumerate(scenes):
            target = _target_for(i, s)
            cur = s
            last_issues = []
            ok = False
            _degen_attempts23 = 0  # CC round-23 P0-3：连续空/摆烂稿跨温度计数
            _bp = next((b for b in bps if int(b.get("scene_num", 0) or 0) == int(getattr(s, "scene_id", 0) or 0)), None)
            _need_beats = len([b for b in ((_bp or {}).get("beats") or []) if b])
            for _attempt in range(2):
                _passed, _issues = validate_scene_text(cur.scene_text, target)
                _all_issues = list(_issues)
                # CC P0：仅对真实 strict JSON 场景强制 beats_covered 逐条覆盖（mock/纯散文回退不强制）。
                if getattr(cur, "structured", False):
                    _bok, _bissue = validate_beats_covered(getattr(cur, "beats_covered", []) or [], _need_beats)
                    if not _bok:
                        _all_issues.append(_bissue)
                # CC round-7 Q5：场景级时间线/年龄越界（先在场景层有界重生，硬门兜底）
                _tl_issue = detect_timeline_jump(
                    cur.scene_text, task_card.get("timeline_anchor"), chapter_num)
                if _tl_issue:
                    _all_issues.append(_tl_issue)
                if _passed and not _all_issues:
                    ok = True
                    break
                last_issues = _all_issues
                logger.warning(f"Scene {cur.scene_id} validation failed (attempt {_attempt+1}/2): {_all_issues}, regenerating")
                directives = self._scene_issues_to_directives(_all_issues, target, _need_beats)
                if _tl_issue:
                    self._chapter_gate_fired = True
                    directives.append(anchor_fix_directive(_tl_issue, task_card.get("timeline_anchor")))
                bad_sample = cur.scene_text.strip()[:120] if (cur.scene_text or "").strip() else None
                # CC round-7 P0-2 救援分层（取代旧的 0.95→1.10 递增温度，高温会诱发逐字重复）：
                #  - 截断(length)：默认温度，不强惩罚
                #  - 已出现自重复退化：降到 0.7 + 强 penalty（0.75/0.6），专治重复循环
                #  - 近空(<max(t*0.15,150))/占位/乱码等真退化：默认温度 + penalty 0.4
                #  - 连贯但偏短(≥近空阈值、仅字数/beat不足)：保持默认温度、不上 penalty
                #    （实测 penalty 在结构化短场景上偶发空/乱码）；两次仍短则交给有界扩写，不判死
                _truncated = (str(getattr(cur, "finish_reason", "") or "") == "length") or any(
                    str(x).startswith("truncated") for x in _all_issues)
                _repeated, _rep_sample = find_self_repetition(cur.scene_text or "")
                _near_now = is_near_empty(cur.scene_text or "", target)
                _garbled = any(str(x).startswith(
                    ("placeholder_detected", "high_freq_repeat", "continuous_same_char"))
                    for x in _all_issues)
                # CC round-8: 合法 beats 全覆盖的连贯极短不算真退化，保持默认参数、不上 penalty
                _coherent_now = _is_coherent_short(cur, _need_beats)
                _degenerate = (_near_now or _garbled) and not _coherent_now
                if _truncated:
                    _temp, _fp, _pp = None, None, None
                elif _repeated:
                    _temp, _fp, _pp = 0.7, 0.75, 0.6
                    directives.append(
                        f"上一稿陷入逐字自我重复（重复片段如“{_rep_sample[:24]}…”）。"
                        "本次必须用全新、不重复的表达一次性写足篇幅，严禁回环复读同一句段。")
                elif _degenerate:
                    # CC round-23 P0-3：0字/<下限摆烂稿跨温度快速重试（0.7→0.85，封顶0.85）
                    _temp = _sr15.degenerate_retry_temperature(_degen_attempts23)
                    _degen_attempts23 += 1
                    _fp, _pp = 0.4, 0.4
                    _cur_len23 = len(cur.scene_text or "")
                    if _cur_len23 < max(int(target * 0.15), 150):
                        directives.append(_sr15.empty_scene_retry_directive(_cur_len23, _need_beats))
                else:
                    _temp, _fp, _pp = None, None, None
                cur = self._regen_scene_for_id(
                    task_card, cur.scene_id, scenes,
                    negative_examples=[bad_sample] if bad_sample else None,
                    temperature_override=_temp,
                    frequency_penalty=_fp, presence_penalty=_pp,
                    fix_directive=("\n".join(f"- {d}" for d in directives) if directives else None),
                )
            # CC round-21 P1：结构与硬伤都合格、但初稿系统性偏短（< target*0.7）时，源头再
            # 定向重生一次（每场景最多 +1 次调用），不把上千字缺口甩给有界扩写；新稿不更长
            # 则保留旧稿，下游扩写/长度门兜底。
            _len_floor21 = int(target * 0.7)
            if ok and getattr(cur, 'structured', False) and len(cur.scene_text or '') < _len_floor21:
                try:
                    _ld21 = (
                        f"上一稿仅 {len(cur.scene_text or '')} 字，远低于本场景 {target} 字硬性下限"
                        f"（至少 {_len_floor21} 字）。必须把每个 beat 用动作、对话、感官细节与即时心理"
                        "逐拍演足，一次性写满篇幅；严禁概述、跳步、一笔带过或提前收尾。"
                    )
                    _ns21 = self._regen_scene_for_id(
                        task_card, cur.scene_id, scenes,
                        negative_examples=[(cur.scene_text or '')[:120]],
                        fix_directive=_ld21)
                    if len(_ns21.scene_text or '') > len(cur.scene_text or ''):
                        cur = _ns21
                        logger.warning(
                            f"Scene {s.scene_id} CC21 under-target regen -> "
                            f"{len(cur.scene_text or '')} chars (floor {_len_floor21}, target {target})")
                except Exception as _e21:
                    logger.warning(f"CC21 under-target regen failed scene {s.scene_id}: {_e21}")
            if not ok:
                # 两次重生后仍只是“连贯短文”（达到近空阈值，且无截断/占位/重复/乱码/时间线等
                # 硬伤，仅字数或 beats 覆盖不足）：不在此判死，交给 Phase2 有界扩写补细节，
                # 避免一个 300~800 字的正常短场景拖垮整章。真退化（近空/乱码）仍判废。
                _hard_left = [
                    x for x in last_issues
                    if not str(x).startswith(("length_too_short", "beats_covered_insufficient"))
                ]
                _coherent_floor = max(int(target * 0.15), 150)
                # CC round-10 Q3：只剩字数/beat 不足、且无截断/乱码/占位/重复等硬伤时，
                # 连贯短稿下限放宽到约 target*0.06（≥120字），交有界扩写救回，避免 197 字这类
                # 完整但短的场景被直接判死 HALT；真正近空(<120)/乱码仍在此判废。
                _soft_coherent_floor = max(int(target * 0.06), 120)
                _coherent_final = _is_coherent_short(cur, _need_beats)
                if (not _hard_left and (_coherent_final or
                        len(cur.scene_text or "") >= _coherent_floor or
                        len(cur.scene_text or "") >= _soft_coherent_floor)):
                    logger.warning(
                        f"Scene {s.scene_id} coherently short ({len(cur.scene_text or '')} chars, "
                        f"beats_ok={_coherent_final}) after 2 regens, no structural defect "
                        f"→ defer to bounded expansion")
                    scenes[i] = cur
                    continue
                # CC round-15：用韧性分级判定“真·无法自动修复”。有句末/演到beat的短稿（L3）
                # 即使字数<80 也不再判死（有界扩写负责补长）；只有 HARD_DEGENERATE / MALFORMED_SHORT
                # （无句末或几乎空）才计为无法修复。
                _bp_b = next((b for b in bps if int(b.get("scene_num", 0) or 0) == int(getattr(s, "scene_id", 0) or 0)), None)
                _beats15 = [b for b in ((_bp_b or {}).get("beats") or []) if b]
                try:
                    _cls15 = _sr15.classify_scene_output(
                        cur.scene_text or "", str(getattr(cur, "finish_reason", "") or ""),
                        target, _beats15)
                except Exception:
                    _cls15 = "MALFORMED_SHORT"
                if _cls15 in ("DEGENERATE_SHORT", "UNDER_COVERED", "USABLE"):
                    logger.warning(
                        f"Scene {s.scene_id} class={_cls15} ({len(cur.scene_text or '')} chars) "
                        f"after 2 regens → salvage to bounded expansion/density gate, not HALT")
                    scenes[i] = cur
                    continue
                # CC round-7 语义保留：mock/纯散文回退（非结构化）仍按单场有界重生处理，
                # 救不活即抛 SceneUnrecoverableError，不进入 CC15 结构化场景的章级聚合。
                if not getattr(cur, "structured", False):
                    raise SceneUnrecoverableError(
                        f"Scene {s.scene_id} near-empty/invalid after 2 regenerations: {last_issues}",
                        chapter=chapter_num, scene_id=s.scene_id,
                    )
                # CC round-25 P0-1：结构化真退化（HARD/MALFORMED/截断或仍<300）先走章内 L2/L3 便宜抢救，
                # 救回即采用；两级耗尽仍不达标才计入 _unrecoverable_ids（文末 ≥2 才 L4 整章重排）。
                _rescued25 = self._cc25_rescue_scene_l2l3(task_card, cur, _bp_b, target, _need_beats)
                if _rescued25 is not None:
                    scenes[i] = _rescued25
                    continue
                _unrecoverable_ids.append(int(getattr(s, "scene_id", i + 1) or (i + 1)))
                scenes[i] = cur
                logger.error(
                    f"Scene {s.scene_id} UNRECOVERABLE class={_cls15} "
                    f"({len(cur.scene_text or '')} chars): {last_issues} → mark known-defect, "
                    "chapter kept alive (HALT only if >=2 such scenes)")
            scenes[i] = cur

        # CC round-25 P0-1 Level-4（取代旧的章级近空熔断）：这里的 _unrecoverable_ids 只包含
        # L1 跨温度重试 + L2 聚焦重写 + L3 单beat拆分全部耗尽后仍未达标的场景。同批 ≥2 个这样
        # 的场景才判真·近空簇、整章重采（上限沿用既有整章重排预算）；仅 1 个时保留为已知缺陷。
        if len(_unrecoverable_ids) >= 2:
            raise ChapterResampleRequiredError(
                f"{len(_unrecoverable_ids)} unrecoverable scenes {_unrecoverable_ids} "
                "after rescue ladder; resample chapter with fresh plan",
                chapter=chapter_num, scene_ids=_unrecoverable_ids,
                replan="scene_near_empty_cluster",
            )
        if _unrecoverable_ids:
            self._flag_for_human(
                chapter_num, 0,
                f"known-defect scene(s) {_unrecoverable_ids}: near-empty after rescue, "
                "assembled anyway; please spot-read")

        # Phase 2: cross-scene overlap detection
        overlaps = detect_scene_overlap(scenes)
        if overlaps:
            for sid, desc_list in overlaps.items():
                logger.warning(f"Scene {sid} overlap detected: {desc_list}")
            # Regenerate all overlapping scenes (up to 2x)
            for sid in sorted(overlaps.keys()):
                scene_obj = next((s for s in scenes if s.scene_id == sid), None)
                if scene_obj is None:
                    continue
                # Collect representative overlap text as negative example
                neg = []
                for d in desc_list[:2]:
                    # Extract sample n-gram from description
                    if "samples:" in d:
                        samples = d.split("samples:")[-1].strip().split(", ")
                        neg.extend(samples[:1])
                for attempt in range(2):
                    try:
                        new_scene = self._regen_scene_for_id(
                            task_card, sid, scenes,
                            negative_examples=neg if neg else [desc_list[0]],
                        )
                        # Replace in list
                        idx = next((i for i, s in enumerate(scenes) if s.scene_id == sid), None)
                        if idx is not None:
                            scenes[idx] = new_scene
                        break
                    except SceneUnrecoverableError:
                        if attempt == 1:
                            raise
                        logger.warning(f"Scene {sid} regen attempt {attempt+1} still failing")
                else:
                    raise SceneUnrecoverableError(
                        f"Scene {sid} overlap unrecoverable after 2 attempts",
                        chapter=chapter_num, scene_id=sid,
                    )
            # Re-check overlaps after regen
            overlaps2 = detect_scene_overlap(scenes)
            if overlaps2:
                raise SceneUnrecoverableError(
                    f"Cross-scene overlap still present after regeneration: {overlaps2}",
                    chapter=chapter_num,
                )

        # Phase 3 (CC28 批B 3b)：相邻场同一现场近重复重演（零 LLM）。逐字 overlap 门判不了
        # “相邻两场把同一事件再演一遍”，这里用 CJK 4-gram 高相似 + 时空未推进判定；命中对
        # 后场定点重生一次（压缩为过渡/推进新时空），重生后仍重演则记硬阻断（进人验，不做
        # 昂贵整章重采）。完全换词的语义重演由批C blueprint 结构化门在源头拦截。
        self._reprise_hard = []
        try:
            from novel_engine.quality.cross_scene_reprise import detect_adjacent_reprise, score_pair
            _reprise_hits = detect_adjacent_reprise(
                [getattr(s, "scene_text", "") or "" for s in scenes])
            for _hit in _reprise_hits:
                _idx = _hit["index"]
                _sid = getattr(scenes[_idx], "scene_id", _idx + 1)
                _directive3b = (
                    "上一场景已经把当前这片现场演完了，你这一稿却把同一地点、同一时刻的同一事件"
                    "近乎原样又演了一遍（叙事时间没有推进）。本次严禁重演其发生经过：要么把前场结果"
                    "用一两句概括为过渡，要么直接推进到新的时间或地点，只写前场尚未发生过的新动作、"
                    "新信息或不可逆的状态变化。")
                try:
                    _new3b = self._regen_scene_for_id(
                        task_card, _sid, scenes, fix_directive=_directive3b,
                        frequency_penalty=0.4, presence_penalty=0.4)
                    scenes[_idx] = _new3b
                    _re = score_pair(
                        getattr(scenes[_idx - 1], "scene_text", "") or "",
                        getattr(_new3b, "scene_text", "") or "")
                    if _re["is_reprise"]:
                        self._reprise_hard.append(
                            f"[相邻重演] 场景{getattr(scenes[_idx-1],'scene_id',_idx)}→{_sid} "
                            f"定点重生后仍高度近重复 sim={_re['similarity']}")
                    else:
                        logger.info(f"Adjacent reprise resolved after scene {_sid} regen {_re['similarity']}")
                except Exception as _e3b:
                    self._reprise_hard.append(
                        f"[相邻重演] 场景{_sid} 与前场重演且定点重生失败: {_e3b}")
            if self._reprise_hard:
                logger.warning(f"ch{chapter_num} adjacent-scene reprise unresolved: {self._reprise_hard}")
        except Exception as _e3b0:
            logger.warning(f"adjacent reprise gate skipped: {_e3b0}")

    @staticmethod
    def _scene_issues_to_directives(issues, target, need_beats: int = 0):
        """Turn terse validator diagnostics into constructive, model-facing repair directives."""
        import re as _re
        out = []
        for it in issues:
            if it.startswith("length_too_short"):
                m = _re.search(r"length_too_short:\s*(\d+)\s*<\s*(\d+)", it)
                actual, floor = (m.group(1), m.group(2)) if m else ("?", "?")
                out.append(
                    f"上一稿正文仅约{actual}字（硬下限{floor}字、目标{target}字），篇幅不足。"
                    f"本次 scene_text 必须写满至少{floor}个中文字并逼近{target}字：把每个 beat 逐一演足"
                    "（每拍约150-250字，动作、环境、感官细节、对话与即时心理交替展开），"
                    "严禁概述、跳步或一笔带过；不得改变既定事件、人物与场景边界。"
                )
            elif it.startswith("beats_covered_insufficient"):
                _need = need_beats or 3
                out.append(
                    f"上一稿未按结构化契约在 beats_covered 中逐条列出本场景全部 beat（要求至少{_need}条）。"
                    f"本次必须先在 beats_covered 中为每个 beat 各写一句完整的覆盖说明（不少于{_need}条、一一对应），"
                    "确认无遗漏后再据此把 scene_text 逐拍演足；严禁跳过列点或只回一两句正文就提前收尾。"
                )
            elif it.startswith("high_freq_repeat"):
                out.append(
                    "上一稿出现整句重复或 JSON 代码残留。本次用不重复的新鲜表达写纯叙事正文，"
                    "scene_text 内严禁出现引号键名、换行缩进的 JSON 结构或 ``` 代码围栏。"
                )
            elif it.startswith("placeholder"):
                out.append("上一稿含有占位/省略文字（待补充、略、TODO 等）。严禁任何占位，必须写出完整成稿正文。")
            elif it.startswith("continuous_same_char"):
                out.append("上一稿含有连续重复字符。本次输出须为通顺自然的中文叙事。")
            elif it.startswith("truncated"):
                out.append(
                    "上一稿在句子中途被截断、没有完整收尾（末尾不是句号/问号/感叹号/省略号）。"
                    "本次必须写完整段并让最后一句自然收束；如内容较多，优先保证本场景在句末完整结束，严禁半句或破折号悬空收尾。"
                )
            elif it.startswith("markdown_scaffolding"):
                out.append(
                    "上一稿不是纯叙事正文：含有“## 正文”之类的 markdown 标题/分节标记，或先用一段概述预演后续情节再分节重演。"
                    "本次只交付本场景当下发生的连续叙事正文，严禁任何 # 号标题、‘正文/引子/楔子’等分节字样，"
                    "严禁提前概述或搬演后续场景（含后续的啼鸣异象、村民聚集、天亮等尚未在本场景发生的情节）；开头直接进入本场景动作。"
                )
            else:
                out.append(f"修正上一稿的问题：{it}")
        return out

    def _regen_scene_for_id(
        self,
        task_card: dict,
        scene_id: int,
        all_scenes: list,
        negative_examples: list[str] | None = None,
        temperature_override: float | None = None,
        fix_directive: str | None = None,
        frequency_penalty: float | None = None,
        presence_penalty: float | None = None,
    ) -> "SceneOutput":
        """Regenerate a single scene by id, injecting negative examples into prompt."""
        bps = task_card.get("scene_blueprints", [])
        bp = next((b for b in bps if int(b.get("scene_num", 0) or 0) == scene_id), None)
        if bp is None:
            bp = {"scene_num": scene_id, "goal": "", "location": "", "characters": [], "beats": []}
        synopsis_text = (getattr(self, "_current_synopsis_text", "") or "")
        try:
            return self.writer.generate_scene(
                task_card, bp, synopsis_text, negative_examples=negative_examples,
                all_blueprints=bps, temperature_override=temperature_override,
                fix_directive=fix_directive,
                frequency_penalty=frequency_penalty, presence_penalty=presence_penalty,
            )
        except Exception as e:
            logger.error(f"Scene {scene_id} regeneration failed: {e}")
            raise SceneUnrecoverableError(
                f"Scene {scene_id} regeneration failed: {e}",
                chapter=task_card.get("chapter_num"), scene_id=scene_id,
            )

    def _cc25_rescue_scene_l2l3(
        self,
        task_card: dict,
        cur: "SceneOutput",
        bp: dict | None,
        target: int,
        need_beats: int,
    ) -> "SceneOutput | None":
        """CC round-25 P0-1：单场近空的章内便宜抢救（Level 2 聚焦重写 → Level 3 单beat拆分）。

        仅在 L1 跨温度重生后该场仍空/<300字/截断时调用。两级各 1 次预算；任一级产出
        >=300 字、无脚手架且经韧性分级非 HARD/MALFORMED 的正文即采用（仍偏长不足的部分
        交给既有有界扩写/密度门）。两级都救不回返回 None，由调用方计入 L4 章级聚合。
        """
        from novel_engine.quality import scene_resilience as _sr25
        sid = int(getattr(cur, "scene_id", 0) or (bp or {}).get("scene_num", 0) or 0)
        beats = [b for b in ((bp or {}).get("beats") or []) if b]

        def _accept(prose: str, level: str) -> "SceneOutput | None":
            prose = (prose or "").strip()
            try:
                prose, _leaked = _sr25.strip_leaked_tokens(prose)
            except Exception:
                pass
            if len(prose) < 300 or "【" in prose or "】" in prose:
                return None
            try:
                _cls = _sr25.classify_scene_output(prose, "stop", target, beats)
            except Exception:
                _cls = "MALFORMED_SHORT"
            if _cls in ("HARD_DEGENERATE", "MALFORMED_SHORT"):
                return None
            repaired = SceneOutput(
                sid, prose, getattr(cur, "hook", "") or "",
                list(getattr(cur, "beats", []) or beats),
                beats_covered=list(beats) if beats else list(getattr(cur, "beats_covered", []) or []),
                structured=True, finish_reason="stop",
            )
            logger.warning(
                f"Scene {sid} ch{task_card.get('chapter_num', 0)} rescued at {level}: "
                f"class={_cls} {len(prose)} chars")
            return repaired

        # Level 2：同任务卡单场聚焦重写
        try:
            _p2 = self.writer.focused_rewrite_scene(task_card, bp or {"scene_num": sid}, target)
        except Exception as _e2:
            logger.warning(f"Scene {sid} L2 focused rewrite raised: {_e2}")
            _p2 = ""
        _r2 = _accept(_p2, "L2_focused") if _p2 else None
        if _r2 is not None:
            return _r2

        # Level 3：单 beat 拆分重写（整场仅 1 遍）
        try:
            _p3 = self.writer.beat_split_rewrite_scene(task_card, bp or {"scene_num": sid}, target)
        except Exception as _e3:
            logger.warning(f"Scene {sid} L3 beat-split raised: {_e3}")
            _p3 = ""
        return _accept(_p3, "L3_beat_split") if _p3 else None

    def _stage_write(self, task_card: dict, synopsis: dict) -> str:
        """阶段4：正文生成 + 润色（带确定性校验与成品净化）。

        规范顺序：生成结构化场景 → 扩写偏短场景 → polish_scenes 并发润色
        → 只组装一次 novel_text → 净化 → 发布。
        由此保证扩写与润色结果必然进入成稿文本。

        兼容路径：generate_full_chapter 返回字符串且 last_scenes 为空时（mock/重写路径），
        直接使用返回值作为成稿文本，跳过扩写和 polish_scenes。
        """
        self.state_machine.transition(ChapterPhase.WRITE_SCENE)
        # CC round-9：本章是否有任一确定性门命中（即使已修复）；命中章默认三评
        self._chapter_gate_fired = False
        # CC round-9：是否结构化场景章（用于禁用旧的整章续写凑字兜底）
        self._chapter_structured = False
        synopsis_text = synopsis.get("synopsis", "")
        pacing_constraints = PacingAdvisor().pre_write_constraints(synopsis_text)
        chapter_num = int(task_card.get("chapter_num", 0) or 0)
        # D1 resume-skip：journal 已有场景不再重生成，只生成缺失场景
        bps = task_card.get("scene_blueprints", []) or []
        done_ids = completed_scene_ids(self.root, chapter_num) if bps else set()
        need_merge = False
        missing = []  # fresh 路径无已完成场景；结构化路径统一引用
        # 记录 generate_full_chapter 的字符串返回值，用于非结构化兼容路径
        _gen_str_result = ""
        if done_ids:
            missing = [bp for bp in bps if int(bp.get("scene_num", 0) or 0) not in done_ids]
            need_merge = True
            if missing:
                logger.info(f"Resume chapter {chapter_num}: skip journaled {sorted(done_ids)}, "
                            f"generate {[b.get('scene_num') for b in missing]}")
                gen_card = dict(task_card, scene_blueprints=missing)
                _gen_str_result = self.writer.generate_full_chapter(gen_card, synopsis, pacing_constraints)
                self._journal_validated_scenes(chapter_num)
            else:
                logger.info(f"Resume chapter {chapter_num}: all scenes journaled {sorted(done_ids)}, reuse journal")
        else:
            _gen_str_result = self.writer.generate_full_chapter(task_card, synopsis, pacing_constraints)
            self._journal_validated_scenes(chapter_num)
        if need_merge:
            # resume 合并：journal 场景为底，新生成场景覆盖同 id，按 scene_id 排序
            journaled = {s.scene_id: s for s in self._load_journal_scenes(chapter_num)}
            for s in (getattr(self.writer, "last_scenes", None) or []):
                journaled[s.scene_id] = s
            merged = [journaled[k] for k in sorted(journaled)]
            if merged:
                self.writer.last_scenes = merged
        # 获取结构化场景列表（扩写 + 润色统一在此列表上操作）
        _scenes_list = getattr(self.writer, "last_scenes", None) or []
        # pkg2e: deterministic validation + overlap detection before expand/polish
        if _scenes_list:
            self._validate_and_regen_scenes(_scenes_list, task_card, chapter_num)
            # CC round-8 P0-2：按 sequence_index 故事时间排序（不可唯一排序→质量重规划）
            self._apply_sequence_order(task_card, _scenes_list)
        # 兼容路径：last_scenes 为空时（mock/重写），直接使用字符串返回值
        novel_text = ""
        if _scenes_list:
            # 结构化路径：近空场景已在上方判废重生；此处只对 0.4~0.6 目标的偏短场景扩写一次，
            # 再统一 polish_scenes，最后在唯一组装点拼出成稿（杜绝 4 份重写拼接）。
            _new_ids = {s.scene_id for s in _scenes_list}
            try:
                from novel_engine.core.quality_policy import load_quality_policy, derive_scene_targets
                _wp = load_quality_policy(self.root)
                _chapter_target = int(_wp["chapter_target_chars"])
                if bps:
                    _scene_targets = derive_scene_targets(_chapter_target, len(bps))
                    if missing:
                        _new_ids = {int(bp.get("scene_num", 0)) for bp in missing}
                    elif not done_ids:
                        _new_ids = {s.scene_id for s in _scenes_list}
                    else:
                        _new_ids = set()
                    def _target_for(_idx):
                        if _idx < len(_scene_targets):
                            return _scene_targets[_idx]
                        return _chapter_target // max(1, len(_scenes_list))
                    from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _asc
                    _expand_conc = int(getattr(self.outline_router, "concurrency", 4) or 4)
                    # CC round-9 Q4-3：有界扩写按场景并发（原为串行）；连贯极短先到 0.6 目标，首轮仍偏短且在增长再补一轮。
                    # CC round-26（r34 实测 4798/8000 偏短硬伤）：flash 常在 0.6~0.85 倍目标交付，
                    # 旧 0.6 门槛会让这些场跳过扩写，4 场累计仅约 4800~6000 字。把扩写门槛提到
                    # 0.85×目标（对齐 chapter min_ratio），两轮内把每场抬到接近目标，保证整章≈8000。
                    for _ea in range(2):
                        _todo = [(_i, _s) for _i, _s in enumerate(_scenes_list)
                                 if _s.scene_id in _new_ids
                                 and len(_s.scene_text) < int(0.85 * _target_for(_i))]
                        if not _todo:
                            break
                        def _expand_one(_item):
                            _i, _s = _item
                            _st = _target_for(_i)
                            _p = (
                                "请在【不改变任何情节、beats、出场人物与事件顺序】的前提下，扩写下面这一场小说正文，"
                                f"把篇幅自然补到约{_st}字。扩写只能做信息增量，严禁注水：\n"
                                "【禁止】1)堆砌形容词/副词渲染（如“格外/异常/深深地/仿佛”等修饰词叠床架屋）；"
                                "2)近义复句（同一意思换措辞重复，如“寒意刺骨，冷得彻骨”）；"
                                "3)不指向任何具体可感细节的抽象氛围渲染；4)新增事件、人物或情节。\n"
                                "【只允许】1)补一个具体感官细节（视/听/触/嗅觉中能被直接感知的细节，而非抽象形容）；"
                                "2)把一个概括动作拆成具体动作分解（如“他走过去”→“他迈过门槛，鞋底碾过碎石”）；"
                                "3)若本场有对白，补一句说话的语气、停顿或伴随小动作。\n"
                                "新增字数必须与新增的具体名词/动词数量成正比；直接输出扩写后的完整场景正文，"
                                "不要解释、不要分条、不要保留任何标记。\n\n"
                                f"{_s.scene_text}")
                            _ex = call_llm(_p, system_prompt="你是资深网文责编，只做“具体信息增量”式扩写：补感官、补动作分解、补对白语气；绝不加形容词渲染、近义复句、抽象氛围或任何新事件", output_json=False, client=self.refine_router)
                            return _i, _s, (_ex or "")
                        _grew = 0
                        with _TPE(max_workers=max(1, _expand_conc), thread_name_prefix="expand") as _exx:
                            _futs = [_exx.submit(_expand_one, _it) for _it in _todo]
                            for _f in _asc(_futs):
                                try:
                                    _i, _s, _ex = _f.result()
                                except Exception as _ee:
                                    logger.warning(f"Scene expansion failed: {_ee}")
                                    continue
                                if _ex and len(str(_ex)) > len(_s.scene_text):
                                    _diff = len(str(_ex)) - len(_s.scene_text)
                                    _s.scene_text = str(_ex)
                                    _grew += 1
                                    logger.info(f"Expanded scene {_s.scene_id} (round {_ea+1}) to {len(_s.scene_text)} chars (+{_diff})")
                        if _grew == 0:
                            break
                self.state_machine.transition(ChapterPhase.POLISH)
                try:
                    # CC round-9 Q4-1：达字数且过门场景跳过 polish（零风险省时）；可用 pipeline.skip_polish_on_target=false 关闭。
                    _skip_polish = bool((self.config.get("pipeline", {}) or {}).get("skip_polish_on_target", True))
                    if _skip_polish:
                        _polish_ids = {_s.scene_id for _i, _s in enumerate(_scenes_list)
                                       if _s.scene_id in _new_ids and len(_s.scene_text) < _target_for(_i)}
                        if _polish_ids != _new_ids:
                            logger.info(f"Skip polish for on-target scenes; polish {sorted(_polish_ids)} of {sorted(_new_ids)}")
                    else:
                        _polish_ids = _new_ids
                    _polished, _flags = self.writer.polish_scenes(_scenes_list, task_card, client=self.polish_router, only_ids=_polish_ids)
                    self.writer.last_scenes = _polished
                    _scenes_list = _polished
                    self._write_polish_flags(chapter_num, _scenes_list, _flags)
                    logger.info(f"polish_scenes completed: {sum(_flags)}/{len(_flags)} scenes polished")
                except Exception as _pe:
                    logger.warning(f"polish_scenes skipped: {_pe}")
                # CC round-26（r35 实测 8741->4508 硬伤）：扩写+polish 后的【最终篇幅】必须回写
                # journal——load_scenes 对同一 scene_id 取最新非空记录，后续确定性门/修复循环都以
                # journal 为唯一事实源；不回写则它们会把扩写成果丢弃、回退成原始短稿。
                if not (self.config.get("llm") or {}).get("use_mock"):
                    try:
                        for _sfin in _scenes_list:
                            append_scene(self.root, chapter_num, {
                                "scene_id": _sfin.scene_id,
                                "scene_text": _sfin.scene_text or "",
                                "hook": getattr(_sfin, "hook", ""),
                                "beats": getattr(_sfin, "beats", [])})
                        logger.info(
                            f"Journal synced with expanded/polished scenes ch{chapter_num}: "
                            f"{[(s.scene_id, len(s.scene_text or '')) for s in _scenes_list]}")
                    except Exception as _je26:
                        logger.warning(f"expanded-scene journal sync failed: {_je26}")
            except Exception as _se:
                logger.warning(f"Single-scene lower bound check skipped: {_se}")
            novel_text = self._assemble_chapter_text(_scenes_list) if _scenes_list else ""
        else:
            # 兼容路径：generate_full_chapter 返回纯字符串（mock/整章重写）时直接作为成稿
            novel_text = _gen_str_result or ""
        self._chapter_structured = bool(_scenes_list)

        # 成品净化：草稿保留标记供 patcher，发布版剥离（单一净化源，章号强制校正）
        purified = purify_novel_for_publish(novel_text, chapter_num=task_card.get("chapter_num"))
        self._draft_novel = novel_text
        self.current_novel = purified
        logger.info(f"Novel text generated (draft {len(novel_text)} chars → purified {len(purified)} chars)")
        # CC round-7 P0-3：跨章重演边界门（仅结构化路径；assembly 后 reviewer 前独立门）
        _bn = int(task_card.get("chapter_num", 0) or 0)
        if _scenes_list:
            try:
                purified = self._run_boundary_gate(_bn, task_card, _scenes_list, purified)
                self.current_novel = purified
            except Exception as _be:
                logger.warning(f"Boundary gate skipped: {_be}")
        # CC round-8 P0-2：章内时间/因果一致性门（乱序已在上方排序；此处抓“提前演后果”）
        if _scenes_list:
            purified = self._run_continuity_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-9 P0-1：设定泄漏 / 时间锚越界 / 越权新增场景 确定性硬门
        if _scenes_list:
            purified = self._run_scope_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-18 P0-1：非中文拉丁字符泄漏（重生1次；残留硬阻断）
        if _scenes_list:
            purified = self._run_latin_leak_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-22 P0-1：低能动性主角成人化内心独白（确定性截断/定点重生）
        if _scenes_list:
            purified = self._run_pov_interiority_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-22 P0-2：任务卡硬约束词面化履约（动作禁行/身份保密）
        if _scenes_list:
            purified = self._run_constraint_compliance_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-10 P0-1：内容密度覆盖率门（具体事件/具名互动/伏笔揭示）
        if _scenes_list:
            purified = self._run_density_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-23 P0-1：场景差异化推进（新状态/不可逆变化）+ 相邻场氛围去同质
        if _scenes_list:
            purified = self._run_scene_progression_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-9 P0-3：过全部确定性门后仍不足软下限 → 最短1-2场景定向补写（防注水）
        if _scenes_list:
            purified = self._apply_length_floor(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # CC round-14 P0-1：跨场景重复门（扩写易搬运别场景素材）。句级近逐字确定性切除，
        # 意象级搬运对后现场景定点重生；必须在 length_floor 之后、reviewer 之前。
        if _scenes_list:
            purified = self._run_cross_scene_repeat_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
            # CC round-16 P0-2：相邻场景边界近逐字重演（同义改写交 reviewer/E-loop）
            purified = self._run_boundary_reprise_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
            # CC round-16 P0-1：成稿标点健康门（流水句仅插标点修复/整段重生兜底）
            purified = self._run_punctuation_health_gate(_bn, task_card, _scenes_list, purified)
            self.current_novel = purified
        # 确定性硬校验：命中则在日志中标记，后续在提交前强制拦截
        gate = self._deterministic_quality_gate(purified, task_card)
        if not gate["passed"]:
            logger.warning(f"Deterministic gate flagged chapter {task_card.get('chapter_num')}: {gate['issues']}")
            self._last_deterministic_issues = gate["issues"]
        else:
            self._last_deterministic_issues = []
        # 跨章结尾结构指纹：与前一章 novel 结尾对比，同构则记 soft 提示
        try:
            _cn = task_card.get("chapter_num") or 0
            _prev = self.root / "chapters" / "novel" / f"chapter_{_cn - 1}.txt"
            if _prev.exists():
                _fp_cur = self._structure_fingerprint(purified)
                _fp_prev = self._structure_fingerprint(_prev.read_text(encoding="utf-8"))
                _overlap = _fp_cur & _fp_prev
                if len(_overlap) >= 5:
                    logger.warning(f"Chapter {_cn} ending overlaps prev ({sorted(_overlap)}); suggest varied closing")
        except Exception as _se:
            logger.warning(f"structure fingerprint check skipped: {_se}")
        return purified

    def _apply_sequence_order(self, task_card: dict, scenes: list) -> None:
        """CC round-8：assembly 前按 sequence_index 故事时间升序排列场景。

        sequence_index 缺失/重复导致无法唯一排序时，判任务卡规划失败并交导演绕过缓存
        重排（不在本章猜测时序）。
        """
        bps = task_card.get("scene_blueprints", []) or []
        order, ok = normalize_sequence(bps)
        if not ok:
            raise ChapterResampleRequiredError(
                "sequence_index 缺失或重复，无法确定故事时间顺序，需导演重排任务卡",
                chapter=task_card.get("chapter_num"),
                scene_ids=[int(b.get("scene_num", 0) or 0) for b in bps],
                replan="continuity_block",
            )

        def _key(s):
            sid = int(getattr(s, "scene_id", 0) or 0)
            return (order.get(sid, sid), sid)

        scenes.sort(key=_key)

    def _run_continuity_gate(
        self, chapter_num: int, task_card: dict, scenes: list, assembled_text: str
    ) -> str:
        """CC round-8 P0-2b：assembly 后章内时间/因果一致性门（零 LLM 规则判定）。

        检测某场景是否提前演出了更晚场景才成立的实体状态；命中则对该场景做一次 E
        定点重生（负例带 do_not_depict_before），重生后仍倒置则抛 ChapterResampleRequiredError
        交导演绕过缓存重排任务卡。全部消除则按重生后的场景重新组装并净化返回。
        """
        bps = task_card.get("scene_blueprints", []) or []
        order, _ = normalize_sequence(bps)
        # CC round-8：导演自报关键词实测不可靠（环境词共现误报），默认只启用内置种子规则；
        # 可经 pipeline.use_director_depict_keywords=true 显式打开导演关键词硬判通道。
        _use_director_kw = bool(
            (self.config.get("pipeline", {}) or {}).get("use_director_depict_keywords", False))
        bp_by_id: dict[int, dict] = {}
        for bp in bps:
            sid = int(bp.get("scene_num", 0) or 0)
            b = dict(bp)
            b["_seq"] = order.get(sid, sid)
            bp_by_id[sid] = b

        specs = build_specs(scenes, bp_by_id)
        _prev_es = latest_end_state(self.root, chapter_num)
        _prior_acquired = extract_prior_acquired_entities(_prev_es)
        inversions = detect_inversions(specs, use_director_keywords=_use_director_kw,
                                       prior_acquired_entities=_prior_acquired)
        if not inversions:
            return assembled_text
        self._chapter_gate_fired = True

        spec_by_id = {sp["scene_id"]: sp for sp in specs}
        still_bad: list[int] = []
        for inv in inversions:
            sid = int(inv["scene_id"])
            directive = continuity_fix_directive(inv, spec_by_id.get(sid))
            logger.warning(
                f"Continuity inversion ch{chapter_num} scene{sid} ({inv.get('source')}): "
                f"{inv.get('state')} matched={inv.get('matched')} -> targeted regen")
            cur_scene = next((s for s in scenes if int(getattr(s, "scene_id", 0) or 0) == sid), None)
            try:
                new_scene = self._regen_scene_for_id(task_card, sid, scenes, fix_directive=directive)
            except Exception as e:
                logger.warning(f"Continuity regen failed scene{sid}: {e} -> fallback to excision")
                new_scene = None
            rescue_text = (new_scene.scene_text if new_scene is not None
                           else (getattr(cur_scene, "scene_text", "") if cur_scene is not None else ""))
            probe = dict(spec_by_id.get(sid, {"scene_id": sid}))
            probe["text"] = rescue_text or ""
            others = [sp for sp in specs if sp["scene_id"] != sid]
            recheck = detect_inversions([probe] + others, use_director_keywords=_use_director_kw,
                                        prior_acquired_entities=_prior_acquired)
            accepted = None
            if not any(int(r["scene_id"]) == sid for r in recheck):
                accepted = new_scene if new_scene is not None else cur_scene
            else:
                # CC20 选项C-A：重生(或其失败)后仍倒置 -> 确定性时间越界切除自救一次，同份文本复检
                exc_text, n_exc = excise_temporal_violations(rescue_text or "", task_card.get("timeline_anchor"))
                if n_exc:
                    probe2 = dict(spec_by_id.get(sid, {"scene_id": sid}))
                    probe2["text"] = exc_text
                    rc2 = detect_inversions([probe2] + others, use_director_keywords=_use_director_kw,
                                            prior_acquired_entities=_prior_acquired)
                    if not any(int(r["scene_id"]) == sid for r in rc2):
                        if new_scene is not None:
                            new_scene.scene_text = exc_text
                            accepted = new_scene
                        else:
                            accepted = SceneOutput(sid, exc_text,
                                                   getattr(cur_scene, "hook", "") if cur_scene else "",
                                                   list(getattr(cur_scene, "beats", []) or []) if cur_scene else [])
                        logger.info(f"Continuity temporal excision rescued ch{chapter_num} scene{sid} ({n_exc} hit)")
            if accepted is not None:
                for idx, s in enumerate(scenes):
                    if int(getattr(s, "scene_id", 0) or 0) == sid:
                        scenes[idx] = accepted
                if new_scene is not None or accepted is not cur_scene:
                    try:
                        append_scene(self.root, chapter_num,
                                     {"scene_id": sid, "scene_text": accepted.scene_text,
                                      "hook": getattr(accepted, "hook", ""),
                                      "beats": list(getattr(accepted, "beats", []) or [])})
                    except Exception as je:
                        logger.warning(f"Continuity journal append failed scene{sid}: {je}")
                continue
            logger.warning(f"Continuity inversion persists scene{sid} after regen+excision -> gap-continue")
            still_bad.append(sid)

        self.writer.last_scenes = list(scenes)
        if still_bad:
            # CC20 选项C-B：重生+确定性切除仍倒置 -> gap-continue（隔离+人验+游标继续，不整批 HALT）
            raise ChapterQualityGapError(
                f"章内时序/因果倒置经定点重生与时间越界切除后仍未消除 scenes={sorted(set(still_bad))}，本章留空待补",
                chapter=chapter_num, scene_ids=sorted(set(still_bad)),
                replan="continuity_gap", gap_kind="continuity",
                violations=[{"scene_id": s, "kind": "continuity_inversion"} for s in sorted(set(still_bad))],
            )
        cur = "\n\n".join((getattr(s, "scene_text", "") or "") for s in scenes)
        logger.info(f"Continuity gate resolved ch{chapter_num}; reassembled {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_scope_gate(self, chapter_num: int, task_card: dict, scenes: list, assembled_text: str) -> str:
        """CC round-9 P0-1：assembly 后设定泄漏/时间锚越界/越权增场确定性硬门（零 LLM 判定）。

        命中场景做一次 E 定点重生（fp/pp=0.4，负例点名违禁词/越界时间标记），复检仍命中则
        判 scope_block 交导演绕过缓存重排任务卡。软预警只记录不阻断。
        """
        bps = task_card.get("scene_blueprints", []) or []
        # 越权新增场景：实际场景数 > 任务卡场景数 → 纯计数硬阻断（CC Q1(c)，零歧义）
        if bps and len(scenes) > len(bps):
            raise ChapterResampleRequiredError(
                f"实际场景数 {len(scenes)} 超过任务卡规划 {len(bps)}，疑似越权新增场景，需重新规划",
                chapter=chapter_num,
                scene_ids=[int(getattr(x, "scene_id", 0) or 0) for x in scenes],
                replan="scope_block",
            )
        anchor_ = task_card.get("timeline_anchor")
        try:
            extra = _extract_card_hard_terms(task_card)
        except Exception:
            extra = []
        still_bad: list[int] = []
        fired = False
        changed = False
        for s in list(scenes):
            sid = int(getattr(s, "scene_id", 0) or 0)
            res = detect_scope_violations(s.scene_text or "", chapter_num, anchor_, self.root, extra)
            hard = res.get("hard", [])
            for w in res.get("soft", []):
                logger.info(f"Scope soft-warn ch{chapter_num} scene{sid}: {w.get('kind')} {w.get('term')}")
            if not hard:
                continue
            fired = True
            dawn_hits = [v for v in hard if v.get("kind") == "dawn_overrun"]
            leak_hits = [v for v in hard if v.get("kind") != "dawn_overrun"]

            cur_scene = s
            if leak_hits:
                # 体系/世界观泄漏必须 LLM 定点重生；dawn 时间锚词不进重生 prompt，交确定性切除
                directive = scope_fix_directive(leak_hits)
                # CC round-24 P0-2：scope 修复是“高优先级硬约束先修”，但负例 prompt 不能只要求
                # 删词——r27 ch1 实测删词时把 density/推进锚点一起删光，修复后该场 coverage=0
                # 被 density 门判空送入死路。这里把本场 scene_progression_contract 作为【正向保留
                # 约束】带入同一 prompt（不在下游放松 density 标准，而是让上游修复一次做对）。
                try:
                    from novel_engine.quality import scene_progression_gate as _spg24b
                    _bp24 = next((b for b in bps
                                  if int(b.get("scene_num", 0) or 0) == sid), {}) or {}
                    _c24 = _spg24b.progression_contract(_bp24)
                    _nse24 = _c24.get("new_state_or_entity") or []
                    _irr24 = _c24.get("irreversible_change") or ""
                    if _nse24 or _irr24:
                        directive += (
                            "\n【重要·修复时必须保留推进要素】删除/替换禁用词的同时，"
                            "严禁把本场具体事件一并删掉，正文仍必须明确演出：\n"
                            + "\n".join(f"- 必须落地的新状态/新实体：{x}" for x in _nse24)
                            + (f"\n- 必须发生的不可逆动作/关系变化：{_irr24}" if _irr24 else "")
                        )
                except Exception:
                    pass
                logger.warning(
                    f"Scope leak ch{chapter_num} scene{sid}: "
                    f"{[(v.get('kind'), v.get('term')) for v in leak_hits]} -> targeted regen")
                try:
                    cur_scene = self._regen_scene_for_id(
                        task_card, sid, scenes, fix_directive=directive,
                        frequency_penalty=0.4, presence_penalty=0.4)
                except Exception as e:
                    logger.warning(f"Scope regen failed scene{sid}: {e} -> replan")
                    still_bad.append(sid)
                    continue
            elif dawn_hits:
                logger.info(
                    f"Scope dawn_overrun ch{chapter_num} scene{sid}: "
                    f"{[v.get('term') for v in dawn_hits]} -> deterministic sentence excision")

            # dawn_overrun 确定性整句切除（复用引号/将来时豁免），不调用 LLM
            base_text = cur_scene.scene_text or ""
            excised, removed = excise_dawn_overrun(base_text, chapter_num, self.root, anchor_)
            if removed:
                cur_scene.scene_text = excised
                logger.info(f"Scope dawn excised ch{chapter_num} scene{sid}: {len(removed)} sentence(s)")

            recheck = detect_scope_violations(cur_scene.scene_text or "", chapter_num, anchor_, self.root, extra)
            leak_left = [v for v in recheck.get("hard", []) if v.get("kind") != "dawn_overrun"]
            dawn_left = [v for v in recheck.get("hard", []) if v.get("kind") == "dawn_overrun"]
            if leak_left:
                logger.warning(
                    f"Scope leak persists scene{sid} after regen "
                    f"{[(v.get('kind'), v.get('term')) for v in leak_left]} -> replan")
                still_bad.append(sid)
                continue
            if dawn_left:
                # 理论上切除后不应残留；兜底判重排，避免漏网
                logger.warning(
                    f"Scope dawn still present scene{sid} after excision "
                    f"{[v.get('term') for v in dawn_left]} -> replan")
                still_bad.append(sid)
                continue
            if cur_scene is not s or removed:
                changed = True
            for idx, sc in enumerate(scenes):
                if int(getattr(sc, "scene_id", 0) or 0) == sid:
                    scenes[idx] = cur_scene
            try:
                append_scene(self.root, chapter_num,
                             {"scene_id": sid, "scene_text": cur_scene.scene_text,
                              "hook": getattr(cur_scene, "hook", None),
                              "beats": list(getattr(cur_scene, "beats", []) or [])})
            except Exception as je:
                logger.warning(f"Scope journal append failed scene{sid}: {je}")
        if fired:
            self._chapter_gate_fired = True
        self.writer.last_scenes = list(scenes)
        if still_bad:
            raise ChapterResampleRequiredError(
                f"设定泄漏/时间锚越界经定点重生仍未消除 scenes={sorted(set(still_bad))}，需重排任务卡",
                chapter=chapter_num, scene_ids=sorted(set(still_bad)),
                replan="scope_block",
            )
        if not changed:
            return assembled_text
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Scope gate resolved ch{chapter_num}; reassembled {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_density_gate(self, chapter_num: int, task_card: dict, scenes: list, assembled_text: str) -> str:
        """CC round-10 P0-1：assembly 后内容密度覆盖率确定性门（零 LLM）。

        每场景 concrete_events / named_interactions / info_reveal_points 的关键词覆盖率
        低于阈值，判“氛围堆砌、事件未演足”，定点重生一次并复检；仍不足判 density_block
        交导演绕过缓存重排任务卡。protagonist_interiority 仅软提示不阻断。
        """
        from novel_engine.quality import density_gate
        bps = task_card.get("scene_blueprints", []) or []
        if not bps:
            return assembled_text
        cfg = density_gate.load_density_config(self.root)
        arc = density_gate.arc_for_chapter(chapter_num, self.root)
        req = density_gate.requirements_for(cfg, arc)
        threshold = float(req.get("coverage_threshold", 0.8))
        interior_n = int(req.get("protagonist_interiority", 0) or 0)
        still_bad: list[int] = []
        fired = False

        def _sem(sid, text):
            bpx = next((b for b in bps if int(b.get("scene_num", 0) or 0) == sid), None)
            return density_gate.evaluate_scene_semantic(
                bpx, text or "", req, root=self.root, arc=arc)

        def _commit_scene(sid, ns):
            for k, sc in enumerate(scenes):
                if int(getattr(sc, "scene_id", 0) or 0) == sid:
                    scenes[k] = ns
            try:
                append_scene(self.root, chapter_num,
                             {"scene_id": sid, "scene_text": ns.scene_text,
                              "hook": getattr(ns, "hook", None),
                              "beats": list(getattr(ns, "beats", []) or [])})
            except Exception as je:
                logger.warning(f"Density journal append failed scene{sid}: {je}")

        for s in list(scenes):
            sid = int(getattr(s, "scene_id", 0) or 0)
            bp = next((b for b in bps if int(b.get("scene_num", 0) or 0) == sid), None)
            if bp is None:
                continue
            # 仅对导演显式给密度字段的卡硬判；老卡/模板卡软跳过
            if not density_gate.blueprint_has_explicit_density(bp):
                logger.info(f"Density gate skip ch{chapter_num} scene{sid}: no explicit density fields")
                continue
            base = _sem(sid, s.scene_text or "")
            if base["ratio"] + 1e-9 >= threshold:
                if interior_n and not base.get("interiority"):
                    logger.info(f"Density interiority soft-miss ch{chapter_num} scene{sid} (不阻断)")
                continue
            fired = True
            directive = density_gate.density_directive(
                base, interior_n,
                agency_level=task_card.get("protagonist_agency_level"))
            logger.warning(
                f"Density gap ch{chapter_num} scene{sid}: coverage={base['ratio']:.2f} "
                f"({base['covered_count']}/{base['total']}) missing={len(base['missing'])} -> targeted regen")
            prev_ratio = base["ratio"]
            cur_scene = s
            accepted = None  # 有提升但未达阈的最佳稿
            for rnd in (1, 2):
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes, fix_directive=directive,
                        frequency_penalty=0.3, presence_penalty=0.3)
                except Exception as e:
                    logger.warning(f"Density regen failed scene{sid} r{rnd}: {e} -> replan")
                    still_bad.append(sid)
                    break
                rr = _sem(sid, ns.scene_text or "")
                improved = rr["ratio"] > prev_ratio + 1e-9
                logger.warning(
                    f"Density r{rnd} scene{sid} coverage={rr['ratio']:.2f} "
                    f"({rr['covered_count']}/{rr['total']}) improved={improved}")
                if rr["ratio"] + 1e-9 >= threshold:
                    cur_scene = ns
                    accepted = "pass"
                    break
                if improved:
                    # 趋势向上：保留最佳稿，继续/最终软放行交 reviewer
                    cur_scene = ns
                    prev_ratio = rr["ratio"]
                    accepted = "soft"
                    continue
                # 持平/下降：再无增长趋势
                if rnd == 1:
                    continue
                if accepted is None:
                    still_bad.append(sid)
            if sid in still_bad:
                continue
            if accepted is not None and cur_scene is not s:
                _commit_scene(sid, cur_scene)
                if accepted == "soft":
                    logger.warning(
                        f"Density soft-pass ch{chapter_num} scene{sid}: coverage={prev_ratio:.2f} "
                        f"虽<{threshold:.2f} 但两轮有提升，放行交 reviewer 兜底（不重排）")
        if fired:
            self._chapter_gate_fired = True
        self.writer.last_scenes = list(scenes)
        if still_bad:
            raise ChapterResampleRequiredError(
                f"内容密度两轮重生无改善（疑似真空洞） scenes={sorted(set(still_bad))}，需重排任务卡",
                chapter=chapter_num, scene_ids=sorted(set(still_bad)),
                replan="density_block",
            )
        if not fired:
            return assembled_text
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Density gate resolved ch{chapter_num}; reassembled {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_scene_progression_gate(self, chapter_num, task_card, scenes, assembled_text):
        """CC round-23 P0-1：场景差异化推进 + 氛围占比门（零 LLM 判定，受限 LLM 定点重生）。

        - no_new_state：显式 scene_progression_contract 的场景没在正文落地任何新状态/新实体；
        - atmosphere_saturated：单场纯氛围句占比超阈值；
        - 相邻场氛围意象共享度超阈值 -> 只重生后现场。
        每场景至多重生 2 次，复检测同一组确定性谓词；有改善但未清零走 soft 交 reviewer/E-loop，
        本门【绝不单独】抛整章重排或 HALT（婴儿开篇氛围天然偏高，优先保稳定与低误伤）。
        每场景的推进/氛围指标存 self._scene_progression_metrics 供 reviewer 锚点与 E-loop 使用。
        """
        from novel_engine.quality import scene_progression_gate as spg
        from novel_engine.quality import density_gate as _dg23
        if not scenes:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        cfg = spg.load_progression_config(self.root)
        arc = _dg23.arc_for_chapter(chapter_num, self.root)

        def _sid_of(x):
            return int(getattr(x, "scene_id", 0) or 0) if not isinstance(x, dict) else int(x.get("scene_id", 0) or 0)

        def _text_of(x):
            return getattr(x, "scene_text", "") or "" if not isinstance(x, dict) else str(x.get("scene_text", "") or "")

        def _latest_list():
            latest = {}
            for sc in scenes:
                latest[_sid_of(sc)] = sc
            return [latest[k] for k in sorted(latest)]

        def _bp(sid):
            return next((b for b in (task_card.get("scene_blueprints", []) or [])
                         if int(b.get("scene_num", 0) or 0) == sid), {}) or {}

        check0 = spg.check_chapter_progression(task_card, _latest_list(), cfg, root=self.root, arc=arc)
        self._scene_progression_metrics = {
            sid: {"no_new_state": ev["no_new_state"] and ev["explicit_contract"],
                  "missing_new_state": [d.get("desc", "") for d in ev["missing_new_state"]],
                  "atmosphere_ratio": ev["atmosphere"]["ratio"]}
            for sid, ev in (check0.get("per_scene") or {}).items()
        }
        scene_v = {v["scene_id"]: v for v in check0.get("scene_violations", [])}
        adj_later = {}
        for a in check0.get("adjacent", []) or []:
            adj_later.setdefault(a["later_scene"], []).append(a)
        # CC round-24 P0-4：仅 no_new_state / 单场氛围超标 触发 LLM 重生；相邻场氛围饱和在
        # 本书“雾/迷雾禁区”固定环境下属天然基线，实测重生无法收敛，降级为只记录供 reviewer
        # 锚点/E-loop，不再为它烧 LLM（最大提速点之一）。
        targets = sorted(set(scene_v))
        _adj_only24 = sorted(set(adj_later) - set(scene_v))
        if _adj_only24:
            logger.info(
                f"Progression ch{chapter_num} adjacent-only saturation scenes={_adj_only24} "
                f"-> reviewer/E-loop hint only, no LLM regen (fixed mist environment)")
        if not targets:
            return assembled_text
        self._chapter_gate_fired = True
        changed = False

        def _directive(sid):
            parts = []
            v = scene_v.get(sid)
            if v and "no_new_state" in v.get("types", []):
                parts.append(spg.new_state_directive(v))
            if v and "atmosphere_saturated" in v.get("types", []):
                parts.append(spg.atmosphere_ratio_directive(
                    float(v["detail"]["atmosphere_ratio"]),
                    float(cfg.get("scene_atmosphere_ratio", 0.55))))
            for a in adj_later.get(sid, []):
                parts.append(spg.adjacent_motif_directive(a))
            return "\n\n".join(parts)

        def _still_bad(sid, text):
            ev = spg.evaluate_scene_progression(_bp(sid), text, cfg, root=self.root, arc=arc)
            no_state = ev["explicit_contract"] and ev["no_new_state"]
            sat = ev["atmosphere_saturated"]
            # 相邻复检：该场作为后现场仍与前一在场饱和
            latest = {_sid_of(x): _text_of(x) for x in _latest_list()}
            adj_bad = False
            sids_sorted = sorted(latest)
            for a, b in zip(sids_sorted, sids_sorted[1:]):
                if b == sid:
                    adj_bad = spg.adjacent_atmosphere_overlap(latest[a], latest[b], cfg)["saturated"]
            return no_state, sat, adj_bad

        for sid in targets:
            cur = next((x for x in scenes if _sid_of(x) == sid), None)
            if cur is None:
                continue
            directive = _directive(sid)
            prev_text = _text_of(cur)
            accepted_scene = None
            # CC round-24 P0-4：重生轮次 2 -> 1（no_new_state/氛围超标 1 轮通常足够；仍不行
            # 说明有更深层问题，交 reviewer/E-loop，不在本门继续烧轮次）。
            for rnd in (1,):
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes, fix_directive=directive,
                        frequency_penalty=0.3, presence_penalty=0.3)
                except Exception as e:
                    logger.warning(f"Progression regen failed scene{sid} r{rnd}: {e}")
                    break
                ntext = getattr(ns, "scene_text", "") or ""
                no_state, sat, adj_bad = _still_bad(sid, ntext)
                logger.warning(
                    f"Progression r{rnd} ch{chapter_num} scene{sid}: "
                    f"no_new_state={no_state} atmosphere_sat={sat} adjacent_sat={adj_bad}")
                # 验收只看可修复两项；adjacent 残留属固定环境基线，不阻断接受
                if not no_state and not sat:
                    accepted_scene = ns
                    break
                # 有改善（任一项消除或文本确有变化）继续/最终软保留
                if len(ntext) >= int(0.8 * max(1, len(prev_text))):
                    accepted_scene = ns
                    prev_text = ntext
                    for idx, x in enumerate(scenes):
                        if _sid_of(x) == sid:
                            scenes[idx] = ns
            if accepted_scene is not None:
                for idx, x in enumerate(scenes):
                    if _sid_of(x) == sid:
                        scenes[idx] = accepted_scene
                changed = True
                try:
                    append_scene(self.root, chapter_num,
                                 {"scene_id": sid, "scene_text": getattr(accepted_scene, "scene_text", ""),
                                  "hook": getattr(accepted_scene, "hook", None),
                                  "beats": list(getattr(accepted_scene, "beats", []) or [])})
                except Exception as je:
                    logger.warning(f"Progression journal append failed scene{sid}: {je}")
                # 重生后仍残留 -> soft 交 reviewer/E-loop（不重排、不 HALT）
                ntext = getattr(accepted_scene, "scene_text", "") or ""
                no_state, sat, adj_bad = _still_bad(sid, ntext)
                if no_state or sat or adj_bad:
                    logger.warning(
                        f"Progression soft-pass ch{chapter_num} scene{sid}: residual "
                        f"no_new_state={no_state} atmosphere_sat={sat} adjacent_sat={adj_bad} -> reviewer/E-loop")
        # 更新指标快照（重生后）
        try:
            chk2 = spg.check_chapter_progression(task_card, _latest_list(), cfg, root=self.root, arc=arc)
            self._scene_progression_metrics = {
                sid: {"no_new_state": ev["no_new_state"] and ev["explicit_contract"],
                      "missing_new_state": [d.get("desc", "") for d in ev["missing_new_state"]],
                      "atmosphere_ratio": ev["atmosphere"]["ratio"]}
                for sid, ev in (chk2.get("per_scene") or {}).items()
            }
        except Exception:
            pass
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in _latest_list())
        logger.info(f"Progression gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_cross_scene_repeat_gate(self, chapter_num: int, task_card: dict,
                                     scenes: list, assembled_text: str) -> str:
        """CC round-14 P0-1：跨场景近逐字句确定性切除 + 意象搬运定点重生。"""
        from novel_engine.quality import cross_scene_repeat_gate as crg
        if not scenes:
            return assembled_text
        cfg = crg.load_repeat_config(self.root)
        try:
            fc = load_quality_policy(self.root)
            func_chars = ""
        except Exception:
            func_chars = ""
        try:
            dcfg = __import__(
                "novel_engine.quality.density_gate", fromlist=["load_density_config"]
            ).load_density_config(self.root)
            func_chars = dcfg.get("function_chars", "") or ""
        except Exception:
            pass
        wl = crg.recurring_motif_whitelist(task_card)

        # 每场景取最新对象（重生会替换 list 中同 id）
        def _latest():
            latest = {}
            for sc in scenes:
                latest[int(getattr(sc, "scene_id", 0) or 0)] = sc
            return [latest[k] for k in sorted(latest)]

        changed = False
        # ① 句级近逐字：确定性切除“后现”整句，保留首现
        sv = crg.detect_sentence_repeat(_latest(), cfg, function_chars=func_chars, whitelist=wl)
        if sv:
            drop = crg.repeated_sentence_set(sv)
            fired_sids = sorted({v["scenes"][1] for v in sv})
            logger.warning(
                f"Cross-scene repeat ch{chapter_num}: excise {len(drop)} near-verbatim "
                f"sentence(s) in scenes {fired_sids}")
            for sc in _latest():
                sid = int(getattr(sc, "scene_id", 0) or 0)
                if sid not in fired_sids:
                    continue
                new_text = crg.excise_repeated_sentences(getattr(sc, "scene_text", "") or "", drop)
                if new_text != (getattr(sc, "scene_text", "") or ""):
                    sc.scene_text = new_text
                    changed = True
            self._chapter_gate_fired = True

        # ② 意象级搬运：对后现场景定点重生1次（保留首现场景），残留交 reviewer，不硬 HALT
        iv = crg.detect_image_reuse(_latest(), cfg, task_card, whitelist=wl)
        if iv:
            later_sids = sorted({max(v["scenes"]) for v in iv})
            logger.warning(
                f"Cross-scene image reuse ch{chapter_num}: regen later scenes {later_sids} "
                f"({[v['shared_images'] for v in iv]})")
            for sid in later_sids:
                directive = crg.image_reuse_directive(iv, sid)
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes, fix_directive=directive,
                        frequency_penalty=0.4, presence_penalty=0.4)
                    for idx, sc in enumerate(scenes):
                        if int(getattr(sc, "scene_id", 0) or 0) == sid:
                            scenes[idx] = ns
                    changed = True
                except Exception as e:
                    logger.warning(f"Cross-scene image regen failed scene{sid}: {e}")
            self._chapter_gate_fired = True
            # 重生后复检，仍有显著意象搬运则记 soft（交 reviewer pacing 兜底，不整章重排）
            try:
                iv2 = crg.detect_image_reuse(_latest(), cfg, task_card, whitelist=wl)
                if iv2:
                    logger.warning(
                        f"Cross-scene image reuse persists ch{chapter_num} after regen "
                        f"{[v['shared_images'] for v in iv2]} -> defer to reviewer")
            except Exception:
                pass

        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Cross-scene repeat gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _punct_only_repair(self, paragraph: str) -> str | None:
        """CC round-16 P0-1：定点 LLM“仅插标点”修复一段流水句。

        严格只允许插入标点；用去标点逐字比对校验未越界改写，不合规或仍不健康返回 None
        （调用方改走整段重生）。
        """
        from novel_engine.quality import punctuation_health as ph
        prompt = (
            "下面这段中文小说叙事缺少必要的标点断句。请【仅在合适位置插入逗号、句号、顿号、"
            "分号等标点】，使其符合正常中文叙事节奏。\n"
            "严禁增删、替换、改写任何文字，严禁调整语序，严禁增减任何词语，只允许插入标点。\n"
            "直接输出加好标点后的段落本身，不要任何解释、不要引号包裹、不要markdown代码块。\n\n"
            f"原文：{paragraph}"
        )
        try:
            resp = self.polish_router.chat_completion(
                [{"role": "user", "content": prompt}], temperature=0.2, max_tokens=2000)
            fixed = (resp or {}).get("content", "") or ""
        except Exception as e:
            logger.warning(f"punct-only repair call failed: {e}")
            return None
        fixed = fixed.strip()
        for fence in ("```",):
            if fixed.startswith(fence):
                fixed = fixed.split("\n", 1)[1] if "\n" in fixed else fixed
                if fixed.endswith(fence):
                    fixed = fixed.rsplit(fence, 1)[0]
                fixed = fixed.strip()
        if fixed.startswith(("“", '"', "‘")) and fixed.endswith(("”", '"', "’")):
            fixed = fixed[1:-1].strip()
        if not fixed:
            return None
        if not ph.is_punctuation_only_fix(paragraph, fixed):
            logger.warning("punct-only repair changed wording -> reject, fall back to scene regen")
            return None
        if ph.check_paragraph_punctuation(fixed)["is_unhealthy"]:
            return None
        return fixed

    def _run_latin_leak_gate(self, chapter_num: int, task_card: dict,
                             scenes: list, assembled_text: str) -> str:
        """CC round-18 P0-1：正文拉丁字母（英文残片）泄漏门。

        纯中文古风零拉丁词。命中场景定点重生 1 次并复检；仍有残留则记确定性硬问题
        （提交门据此拦截、force-best 隔离），不依赖 reviewer 偶然发现。
        """
        from novel_engine.quality import latin_leak_gate as llg
        if not scenes:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        leaks = llg.latin_leaks_by_scene(
            [{"scene_id": getattr(s, "scene_id", 0), "scene_text": getattr(s, "scene_text", "") or ""}
             for s in scenes])
        if not leaks:
            return assembled_text
        logger.warning(f"Latin leak ch{chapter_num}: scenes {[x['scene_id'] for x in leaks]} "
                       f"tokens={[x['leaked_tokens'] for x in leaks]} -> targeted rewrite")
        changed = False
        for info in leaks:
            sid = info["scene_id"]
            directive = ("正文出现了英文字母/英文单词，这在纯中文古风里是严重错误。重写本场景时"
                         "严禁出现任何英文字母、英文单词或拉丁字符，正文必须全部为中文，"
                         "专有名词也一律用中文或约定译名；不得改变剧情与情节点。")
            try:
                ns = self._regen_scene_for_id(
                    task_card, sid, scenes,
                    negative_examples=["he decision 不对外透露（正文混入英文残片，严禁）"],
                    fix_directive=directive, frequency_penalty=0.3, presence_penalty=0.3)
                for idx, x in enumerate(scenes):
                    if int(getattr(x, "scene_id", 0) or 0) == sid:
                        scenes[idx] = ns
                changed = True
            except Exception as e:
                logger.warning(f"Latin leak regen failed scene{sid}: {e}")
            # 复检
            latest = next((x for x in scenes if int(getattr(x, "scene_id", 0) or 0) == sid), None)
            still = llg.detect_latin_leak(getattr(latest, "scene_text", "") or "")
            if still["has_leak"]:
                hard = f"[非中文] 场景{sid} 重生后仍含拉丁字符 {still['leaked_tokens']}"
                self._last_deterministic_issues = getattr(self, "_last_deterministic_issues", []) + [hard]
                logger.error(f"Latin leak persists ch{chapter_num} scene{sid} {still['leaked_tokens']} -> hard block")
                self._flag_for_human(chapter_num, getattr(self, "_cur_review_score", 0), hard)
            self._chapter_gate_fired = True
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Latin leak gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_pov_interiority_gate(self, chapter_num, task_card, scenes, assembled_text):
        """CC round-22 P0-1：低能动性主角成人化内心独白门。

        零 LLM 检测：超长/抽象独白片段先确定性截断；截断无法清除抽象禁词的场景再
        定点重生 1 次，重生后仍残留则记确定性硬问题交提交门隔离。仅在 director 标注
        的低能动性状态(infant_low/injured/imprisoned)下生效。
        """
        from novel_engine.quality import pov_interiority_gate as pig
        if not scenes:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        agency = str(task_card.get("protagonist_agency_level", "") or "").strip().lower()
        if not pig.is_restricted(agency):
            return assembled_text

        changed = False
        for sc in list(scenes):
            sid = int(getattr(sc, "scene_id", 0) or 0)
            text = getattr(sc, "scene_text", "") or ""
            if not text:
                continue
            new_text, regen_terms, did_cut = pig.plan_and_excise(text, agency)
            if did_cut and new_text != text:
                sc.scene_text = new_text
                changed = True
                logger.warning(f"POV interiority ch{chapter_num} scene{sid}: deterministic excise of adult monologue")
            if regen_terms:
                logger.warning(
                    f"POV interiority ch{chapter_num} scene{sid}: abstract terms {regen_terms} -> targeted rewrite")
                directive = (
                    "本场景主角此刻为婴儿/重伤/被囚等低能动性状态，不具备成人思考能力。重写时内心活动只允许"
                    "不超过50字的碎片化感官印象/生理反应/模糊情绪（暖、冷、怕、安心）；严禁出现 "
                    + "、".join(regen_terms)
                    + " 等抽象概念或前世身份术语，严禁连贯成人论证式独白；不得改变剧情与情节点。"
                )
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes,
                        negative_examples=["他心想这份恩情此生必报、命运既有安排……（低能动性主角的成人抽象独白，严禁）"],
                        fix_directive=directive, frequency_penalty=0.3, presence_penalty=0.3)
                    ntext = getattr(ns, "scene_text", "") or ""
                    ntext2, nterms, cut2 = pig.plan_and_excise(ntext, agency)
                    if cut2:
                        ntext = ntext2
                    ns.scene_text = ntext
                    for idx, x in enumerate(scenes):
                        if int(getattr(x, "scene_id", 0) or 0) == sid:
                            scenes[idx] = ns
                    if nterms:
                        hard = f"[POV独白] 场景{sid} 重生后仍含抽象内心独白术语 {nterms}"
                        self._last_deterministic_issues = getattr(self, "_last_deterministic_issues", []) + [hard]
                        self._flag_for_human(chapter_num, getattr(self, "_cur_review_score", 0), hard)
                        logger.error(f"POV interiority persists ch{chapter_num} scene{sid} {nterms} -> hard block")
                    changed = True
                except Exception as e:
                    logger.warning(f"POV interiority regen failed scene{sid}: {e}")
                self._chapter_gate_fired = True
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"POV interiority gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_constraint_compliance_gate(self, chapter_num, task_card, scenes, assembled_text):
        """CC round-22 P0-2：任务卡硬约束词面化履约门。

        只对显式带 scene_constraints 的场景硬判；action_forbidden_until /
        identity_concealment 两类。命中->对该场景定点重生1次（负例引用违反的约束原文），
        重生后仍违反则记确定性硬问题交提交门隔离。
        """
        from novel_engine.quality import constraint_compliance_gate as ccg
        if not scenes:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        bps = task_card.get("scene_blueprints", []) or []
        bp_by_id = {int(b.get("scene_num", 0) or 0): b for b in bps}
        changed = False
        for sc in list(scenes):
            sid = int(getattr(sc, "scene_id", 0) or 0)
            bp = bp_by_id.get(sid)
            if bp is None:
                continue
            cons = ccg.constraints_for_blueprint(bp)
            if not cons:
                continue
            text = getattr(sc, "scene_text", "") or ""
            violations = ccg.check_constraint_compliance(text, cons)
            if not violations:
                continue
            logger.warning(
                f"Constraint noncompliance ch{chapter_num} scene{sid}: "
                f"{[v['detail'] for v in violations]} -> targeted rewrite")
            neg = [ccg.violation_negative_example(v) for v in violations][:3]
            directive = (
                "上一版正文违反了本场景任务卡的显式硬约束，必须逐条改正后重写整个场景：\n"
                + "\n".join("- " + ccg.violation_negative_example(v) for v in violations)
                + "\n改正后仍须演足本场景全部 beats，不得改变剧情走向，只删除/改写违规内容。"
            )
            try:
                ns = self._regen_scene_for_id(
                    task_card, sid, scenes, negative_examples=neg,
                    fix_directive=directive, frequency_penalty=0.3, presence_penalty=0.3)
                for idx, x in enumerate(scenes):
                    if int(getattr(x, "scene_id", 0) or 0) == sid:
                        scenes[idx] = ns
                if ccg.check_constraint_compliance(getattr(ns, "scene_text", "") or "", cons):
                    hard = f"[硬约束] 场景{sid} 重生后仍违反任务卡约束 {[v['detail'] for v in violations]}"
                    self._last_deterministic_issues = getattr(self, "_last_deterministic_issues", []) + [hard]
                    self._flag_for_human(chapter_num, getattr(self, "_cur_review_score", 0), hard)
                    logger.error(f"Constraint noncompliance persists ch{chapter_num} scene{sid} -> hard block")
                changed = True
            except Exception as e:
                logger.warning(f"Constraint regen failed scene{sid}: {e}")
            self._chapter_gate_fired = True
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Constraint compliance gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_punctuation_health_gate(self, chapter_num: int, task_card: dict,
                                     scenes: list, assembled_text: str) -> str:
        """CC round-16 P0-1：成稿标点健康门（兜底；扩写/polish 已应在源头少产出流水句）。

        命中段先“仅插标点”修复并做去标点逐字合规校验；2 次仍不合规则对所属场景定点重生。
        残留转 soft（交 reviewer/人验），不因纯标点问题硬 HALT 整章。
        """
        from novel_engine.quality import punctuation_health as ph
        if not scenes:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        # 仅在真实 LLM 客户端上启用（离线 mock 文本无中文标点、且修复调用会返回 None）
        _providers = getattr(self.polish_router, "providers", {}) or {}
        _client = next(iter(_providers.values()), None) if _providers else None
        if _client is None:
            return assembled_text
        _cn = type(_client).__name__.lower()
        if any(k in _cn for k in ("mock", "fake", "stub", "dummy", "blocked", "empty", "both", "long", "test")):
            return assembled_text

        def _is_cjk(s: str) -> bool:
            if not s:
                return False
            cjk = sum(1 for ch in s if "一" <= ch <= "鿿")
            return cjk / max(len(s), 1) >= 0.4

        changed = False
        residual_sids: list[int] = []
        for sc in list(scenes):
            sid = int(getattr(sc, "scene_id", 0) or 0)
            text = getattr(sc, "scene_text", "") or ""
            if not _is_cjk(text):
                continue
            # CC round-12 R2b：句末口径长句拆分（独立于流水段检测），无条件对每个中文场景执行
            ls_persisted = False
            try:
                ls_text, ls_stats = ph.split_long_sentences(text)
                if ls_text != text:
                    text = ls_text
                    changed = True
                    ls_persisted = True
                    logger.info(f"Punctuation gate ch{chapter_num} scene{sid}: "
                                f"long-sentence split resolved {ls_stats.get('split_count', 0)}/"
                                f"{ls_stats.get('long_sentences_detected', 0)}")
            except Exception as _e:
                logger.warning(f"Long sentence split error ch{chapter_num} scene{sid}: {_e}")
            bad = ph.check_text_punctuation(text)
            if ls_persisted:
                # 即使 bad 为空（仅有长句拆分、无流水段），也须持久化回写 scene_text
                sc.scene_text = text.strip()
                self._chapter_gate_fired = True
            if not bad:
                continue
            changed = True
            # CC28 3a：优先零 LLM 确定性断句（只在安全边界增标点/拆段、绝不改字）。
            # 若所有流水段都被零 LLM 修好则直接采用、不耗 LLM；只要还有残留就整体
            # 落回下面原有的“LLM 定点修复→整场重生”路径（不使用部分结果，避免
            # 拆段后 para_index 与旧 bad 列表错位）。
            try:
                _ztext, _zstats = ph.repair_text_punctuation(text)
            except Exception as _e:
                _ztext, _zstats = text, {"residual_unhealthy": len(bad)}
                logger.warning(f"Punctuation deterministic repair error ch{chapter_num} scene{sid}: {_e}")
            if _ztext != text and _zstats.get("residual_unhealthy", 1) == 0:
                sc.scene_text = _ztext.strip()
                self._chapter_gate_fired = True
                logger.warning(f"Punctuation gate ch{chapter_num} scene{sid}: zero-LLM deterministic split "
                               f"resolved ({_zstats.get('changed_paragraphs', 0)} paras, "
                               f"{_zstats.get('inserts', 0)} pauses)")
                continue
            # 按段精确替换仅插标点修复；同段最多 2 次
            paras = text.split("\n")
            sid_resolved = True
            for info in bad:
                pi = info["para_index"]
                if pi >= len(paras):
                    continue
                orig = paras[pi].strip()
                fixed = None
                for _ in range(2):
                    fixed = self._punct_only_repair(orig)
                    if fixed is not None:
                        break
                if fixed is not None:
                    paras[pi] = fixed
                    logger.warning(f"Punctuation gate ch{chapter_num} scene{sid}: "
                                   f"repaired run-on para (run={info['max_unpunctuated_run']})")
                else:
                    sid_resolved = False
            new_text = "\n".join(paras).strip()
            if ph.check_text_punctuation(new_text):
                sid_resolved = False
            if sid_resolved:
                sc.scene_text = new_text
            else:
                # 仅插标点失败/残留 → 对该场景定点重生（强约束正常标点），再复检
                logger.warning(f"Punctuation gate ch{chapter_num} scene{sid}: "
                               f"punct-only failed -> targeted scene rewrite")
                directive = (
                    "上一版部分段落是整段无句读的流水句（成百字中间没有逗号/句号）。重写本场景时必须："
                    "每个完整句不超过约40字；每2-4个分句之间用逗号分隔；正常使用中文句号、逗号，"
                    "对话用引号；严禁输出无标点的长串文字。不得改变剧情与情节点，只改正文断句与表达。"
                )
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes, fix_directive=directive,
                        frequency_penalty=0.3, presence_penalty=0.3)
                    for idx, x in enumerate(scenes):
                        if int(getattr(x, "scene_id", 0) or 0) == sid:
                            scenes[idx] = ns
                    if ph.check_text_punctuation(getattr(ns, "scene_text", "") or ""):
                        residual_sids.append(sid)
                        self._flag_for_human(
                            chapter_num, getattr(self, "_cur_review_score", 0),
                            f"punctuation run-on persists scene{sid} after repair+regen")
                except Exception as e:
                    logger.warning(f"Punctuation scene regen failed scene{sid}: {e}")
                    residual_sids.append(sid)
            self._chapter_gate_fired = True
        if residual_sids:
            self._last_deterministic_soft = getattr(self, "_last_deterministic_soft", []) + [
                f"[标点-软] 场景{sorted(set(residual_sids))} 仍有流水句，已转人验"]
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Punctuation health gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _repair_paragraphs_punct_parallel(self, paragraphs, para_indexes, max_workers=4):
        """CC round-22 提速：对多个流水句自然段并发执行"仅插标点"修复。

        纯并发化，判定与串行版完全一致：每段至多尝试 2 次，仅保留
        ①去标点逐字相同(is_punctuation_only_fix) 且 ②复检健康 的结果。
        返回 {para_index: fixed_text}；不合规/仍流水的段不在结果里。
        复用 polish_router（本就按并发设计），不新增门或质量判定。
        """
        from concurrent.futures import ThreadPoolExecutor
        from novel_engine.quality import punctuation_health as _ph

        jobs = []
        for pi in para_indexes:
            if isinstance(pi, int) and 0 <= pi < len(paragraphs):
                orig = paragraphs[pi].strip()
                if orig:
                    jobs.append((pi, orig))
        if not jobs:
            return {}
        workers = max(1, min(int(max_workers or 1), len(jobs)))

        def _one(job):
            pi, orig = job
            for _ in range(2):
                try:
                    cand = self._punct_only_repair(orig)
                except Exception:
                    cand = None
                if (cand and _ph.is_punctuation_only_fix(orig, cand)
                        and not _ph.check_text_punctuation(cand)):
                    return pi, cand
            return pi, None

        fixed_map = {}
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="punctfix") as _ex:
            for pi, fixed in _ex.map(_one, jobs):
                if fixed is not None:
                    fixed_map[pi] = fixed
        return fixed_map

    def _repair_paragraphs_punct_batched(self, paragraphs, para_indexes):
        """CC round-22 Q4：把多个流水句自然段打包成“1 次”LLM 调用统一仅插标点。

        编号块协议输入/输出；逐段做去标点逐字合规校验(is_punctuation_only_fix)与
        单段健康复检，只有合规且健康的段进结果，其余退回由调用方并发兜底。
        整次调用失败或解析不到任何段 -> 返回 {}（调用方回退并发版）。
        """
        import re as _re
        from novel_engine.quality import punctuation_health as _ph

        jobs = []
        seen = set()
        for pi in para_indexes:
            if isinstance(pi, int) and 0 <= pi < len(paragraphs) and pi not in seen:
                orig = paragraphs[pi].strip()
                if orig:
                    jobs.append((pi, orig))
                    seen.add(pi)
        if not jobs:
            return {}

        def _blk(i, body):
            return f"<<<P{i}>>>\n{body}"

        user_tail = "\n".join(_blk(i, orig) for i, (_, orig) in enumerate(jobs))
        prompt = (
            "下面有多段中文小说叙事，各自缺少必要标点断句。请对每一段【仅在合适位置插入逗号、"
            "句号、顿号、分号、问号、叹号、引号】，使其符合正常中文叙事节奏。\n"
            "严禁增删/替换/改写任何文字，严禁调整语序，严禁增减词语，只允许插入标点。\n"
            "必须严格沿用下面的编号块格式逐段原样返回，编号顺序一致，不要任何解释、"
            "不要markdown代码块、不要引号包裹整段：\n"
            + "\n".join(f"<<<P{i}>>>" for i in range(len(jobs)))
            + "\n\n原文如下：\n" + user_tail
        )
        cap = min(8000, 200 + sum(len(o) for _, o in jobs) + 60 * len(jobs))
        try:
            resp = self.polish_router.chat_completion(
                [{"role": "user", "content": prompt}], temperature=0.2, max_tokens=cap)
            out = (resp or {}).get("content", "") or ""
        except Exception as e:
            logger.warning(f"batched punct-only call failed -> fall back to parallel: {e}")
            return {}
        out = out.strip()
        if out.startswith("```"):
            out = out.split("\n", 1)[1] if "\n" in out else out
            if out.rstrip().endswith("```"):
                out = out.rstrip()[:-3]
            out = out.strip()

        # 解析编号块
        marks = list(_re.finditer(r"<<<\s*P\s*(\d+)\s*>>>", out))
        if not marks:
            logger.warning("batched punct-only returned no parseable blocks -> fall back to parallel")
            return {}
        parsed = {}
        for k, m in enumerate(marks):
            end = marks[k + 1].start() if k + 1 < len(marks) else len(out)
            idx = int(m.group(1))
            body = out[m.end():end].strip()
            parsed[idx] = body

        fixed_map = {}
        for i, (pi, orig) in enumerate(jobs):
            cand = parsed.get(i)
            if not cand:
                continue
            if cand.startswith(("“", '"', "‘")) and cand.endswith(("”", '"', "’")):
                cand = cand[1:-1].strip()
            if (cand and _ph.is_punctuation_only_fix(orig, cand)
                    and not _ph.check_paragraph_punctuation(cand)["is_unhealthy"]):
                fixed_map[pi] = cand
        return fixed_map

    def _run_final_precommit_gate(self, chapter_num, task_card, final_text):
        """CC round-19 Q1：提交前对即将落盘的同一份文本做统一 fail-closed 终检。

        零成本谓词（latin/标点/脚手架头/半角标点/scope硬词）在此同一份字节上重跑。
        - latin/scope 漏到此处=上游门失效（流程异常），终检层不再重生，直接隔离转人工；
        - 标点/脚手架/半角属格式类，允许确定性或受限LLM修复1次，并在同一份文本复检；
          复检仍不过则硬阻断隔离转人工。
        mock 模式整体跳过（mock 文本无中文标点，避免误阻断离线流程）。
        """
        from novel_engine.quality import final_precommit_gate as fg
        from novel_engine.quality import punctuation_health as _ph19

        if (self.config.get("llm") or {}).get("use_mock"):
            return {"text": final_text, "hard_blocked": False, "violations": [], "repaired": False}

        def _scope_terms(txt):
            try:
                v = detect_scope_violations(txt, chapter_num, task_card.get("timeline_anchor"), self.root)
                return [x.get("term") for x in (v.get("hard") or []) if x.get("term")]
            except Exception:
                return []

        def _violations(txt):
            vs = list(fg.evaluate_final_text(txt)["violations"])
            terms = _scope_terms(txt)
            if terms:
                vs.append({"kind": "scope_hard_leak", "detail": f"scope硬词 {terms[:12]}"})
            return vs

        violations0 = _violations(final_text)
        if not violations0:
            return {"text": final_text, "hard_blocked": False, "violations": [], "repaired": False}

        immediate = [v for v in violations0 if v["kind"] in ("latin_leak", "scope_hard_leak")]
        repairable = {v["kind"] for v in violations0 if v["kind"] in fg.REPAIRABLE_KINDS}
        if immediate:
            return {"text": final_text, "hard_blocked": True, "violations": violations0, "repaired": False}

        # 格式类：确定性修复（剥指令头 / 半角转全角）+ 受限 LLM 仅插标点，一次后复检同一文本
        repaired = final_text
        if "scaffolding_header" in repairable:
            repaired = fg.strip_instruction_headers(repaired)
        if "halfwidth_punct" in repairable:
            repaired, _ = fg.normalize_halfwidth_punctuation(repaired)
        if "punctuation" in repairable:
            paras = repaired.split("\n")
            _bad_infos = _ph19.check_text_punctuation(repaired) or []
            _targets = [info.get("para_index") for info in _bad_infos]
            try:
                _mw = int(getattr(self.polish_router, "concurrency", 4) or 4)
            except Exception:
                _mw = 4
            _fixed_map = self._repair_paragraphs_punct_batched(paras, _targets)
            _rest = [pi for pi in _targets if pi not in _fixed_map]
            if _rest:
                _fix2 = self._repair_paragraphs_punct_parallel(paras, _rest, max_workers=_mw)
                _fixed_map.update(_fix2)
            for pi in sorted(_fixed_map):
                paras[pi] = _fixed_map[pi]
            repaired = "\n".join(paras).strip()
            if _fixed_map:
                logger.warning(
                    f"Final gate punct repair ch{chapter_num}: {len(_fixed_map)}/{len(_targets)} "
                    f"run-on paras fixed (1 batched call + {len(_rest)} parallel fallback, workers<={_mw})")

        after = _violations(repaired)
        if not after:
            return {"text": repaired, "hard_blocked": False, "violations": [], "repaired": True}
        return {"text": repaired, "hard_blocked": True, "violations": after, "repaired": True}

    def _run_boundary_reprise_gate(self, chapter_num: int, task_card: dict,
                                   scenes: list, assembled_text: str) -> str:
        """CC round-16 P0-2（经17轮校准）：相邻场景边界“近逐字/高字面重合”重演门。

        只抓表层可验证的边界复述（实词 Jaccard>=阈值且无推进词）；同义改写式语义重演
        不在此处理，交 reviewer pacing + E-loop。命中：确定性删后场首窗口重演段，过短则
        带负例定点重生。
        """
        from novel_engine.quality import boundary_reprise_gate as brg
        if not scenes or len(scenes) < 2:
            return assembled_text
        if (self.config.get("llm") or {}).get("use_mock"):
            return assembled_text
        cfg = brg.load_boundary_config(self.root)
        latest = {}
        for sc in scenes:
            latest[int(getattr(sc, "scene_id", 0) or 0)] = sc
        ordered = [latest[k] for k in sorted(latest)]
        hits = brg.detect_chapter_boundary_reprises(
            [{   "scene_id": getattr(s, "scene_id", 0), "scene_text": getattr(s, "scene_text", "") or ""}
             for s in ordered], cfg, task_card)
        if not hits:
            return assembled_text
        changed = False
        fired = sorted({h["next_scene"] for h in hits})
        logger.warning(f"Boundary reprise ch{chapter_num}: near-verbatim head reprise at scenes {fired} "
                       f"(ratios={[h['overlap_ratio'] for h in hits]})")
        for h in hits:
            sid = h["next_scene"]
            target = next((s for s in scenes if int(getattr(s, "scene_id", 0) or 0) == sid), None)
            if target is None:
                continue
            old = getattr(target, "scene_text", "") or ""
            new = brg.excise_head_reprise(old, cfg)
            if new != old and len(new) >= int((task_card.get("scene_target_chars") or 2000) * 0.4):
                target.scene_text = new
                changed = True
            else:
                # 删除后过短（或窗口即整段）→ 带负例定点重生
                directive = ("禁止在本场景开头复述上一场结尾已经演过的事件（尤其是刚发生的争执/冲突）。"
                             "至多承接一句转折（如‘都少说两句’/新角色介入），随即直接演出新的动作与情节，"
                             "不要重新铺陈已发生的争吵。")
                try:
                    ns = self._regen_scene_for_id(
                        task_card, sid, scenes, negative_examples=[
                            "争吵声像沸水一般翻涌着。那妇人声音尖利……（上一场已演过这场争执，勿复述）"],
                        fix_directive=directive, frequency_penalty=0.4, presence_penalty=0.4)
                    for idx, x in enumerate(scenes):
                        if int(getattr(x, "scene_id", 0) or 0) == sid:
                            scenes[idx] = ns
                    changed = True
                except Exception as e:
                    logger.warning(f"Boundary reprise regen failed scene{sid}: {e}")
            self._chapter_gate_fired = True
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Boundary reprise gate resolved ch{chapter_num}; {len(cur)} chars")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _apply_length_floor(self, chapter_num: int, task_card: dict, scenes: list, assembled_text: str) -> str:
        """CC round-9 P0-3：过全部确定性门后整章仍 < 软下限(默认6800) → 对最短的 1-2 个场景
        定向补写（感官/环境/内心，不新增事件）。单场景增量 ≤ 现字40%；补写文本必须过自相似
        检测（命中则收窄为仅环境/感官重试1次，仍注水则放弃保留原字）且不得重新触发 scope 硬门。
        最多 2 次补写调用；软下限是软的，不足也接受现状进入 reviewer。
        """
        try:
            _wp = load_quality_policy(self.root)
            target_total = int(_wp["chapter_target_chars"])
            target_min = int(target_total * _wp["min_ratio"])
        except Exception as e:
            logger.warning(f"Length floor policy load failed: {e}")
            return assembled_text
        cur_total = sum(len(getattr(x, "scene_text", "") or "") for x in scenes)
        if cur_total >= target_min or not scenes:
            return assembled_text
        deficit0 = target_min - cur_total
        order = sorted(range(len(scenes)),
                       key=lambda i: len(scenes[i].scene_text or ""))[:2]
        from concurrent.futures import ThreadPoolExecutor as _TPE2, as_completed as _asc2

        def _topup(idx):
            sc = scenes[idx]
            base = len(sc.scene_text or "")
            inc = min(deficit0, int(base * 0.4))
            if inc <= 120:
                return idx, ""
            prompt = (
                "在不改变已有情节走向、事件顺序和结尾的前提下，为本场景补写约"
                f"{inc}字。只允许：1) 把此前一笔带过的动作补成具体感官细节；"
                "2) 补一段不引入新事件的环境描写深化氛围；3) 若含对话，适度展开人物内心活动或微表情。"
                "严禁复述已写情节、新增任务卡之外的事件、重复已用比喻或意象、引入任何修炼/体系化名词。"
                "只返回补写并自然衔接后的完整场景正文，不要解释。\n\n" + (sc.scene_text or ""))
            try:
                out = call_llm(prompt, system_prompt="你是资深小说编辑，只在不改变情节的前提下补足细节",
                               output_json=False, client=self.refine_router)
            except Exception:
                out = ""
            return idx, (out or "")

        conc = int(getattr(self.refine_router, "concurrency", 2) or 2)
        results: dict[int, str] = {}
        with _TPE2(max_workers=max(1, min(conc, 2)), thread_name_prefix="floor") as _ex2:
            for _f in _asc2([_ex2.submit(_topup, i) for i in order]):
                try:
                    idx, out = _f.result()
                    results[idx] = out
                except Exception as e:
                    logger.warning(f"Length floor topup failed: {e}")
        changed = False
        for idx, out in results.items():
            if not out:
                continue
            sc = scenes[idx]
            cand = str(out).strip()
            if len(cand) <= len(sc.scene_text or ""):
                continue
            try:
                if find_self_repetition(cand)[0]:
                    base2 = len(sc.scene_text or "")
                    p2 = ("仅用环境与感官细节（光影、雾气、声音、触感、气味）把下面场景自然补足到约"
                          f"{base2 + min(deficit0, int(base2 * 0.4))}字，不新增事件、不新增台词、"
                          "不引入设定名词、不重复已有比喻，只返回完整正文：\n\n" + (sc.scene_text or ""))
                    cand2 = str(call_llm(
                        p2, system_prompt="你是资深小说编辑", output_json=False,
                        client=self.refine_router) or "").strip()
                    if not cand2 or find_self_repetition(cand2)[0] or len(cand2) <= base2:
                        logger.info(f"Length floor scene{getattr(sc,'scene_id',0)} repeated after retry; keep original")
                        continue
                    cand = cand2
            except Exception:
                continue
            try:
                v = detect_scope_violations(cand, chapter_num, task_card.get("timeline_anchor"), self.root)
                if v.get("hard"):
                    logger.info(
                        f"Length floor scene{getattr(sc,'scene_id',0)} reintroduced scope hard "
                        f"{[x.get('term') for x in v.get('hard')]}; keep original")
                    continue
            except Exception:
                pass
            sc.scene_text = cand
            changed = True
        if not changed:
            return assembled_text
        self.writer.last_scenes = list(scenes)
        cur = "\n\n".join((getattr(x, "scene_text", "") or "") for x in scenes)
        logger.info(f"Length floor ch{chapter_num}: {cur_total} -> {len(cur)} (soft min {target_min})")
        return purify_novel_for_publish(cur, chapter_num=chapter_num)

    def _run_boundary_gate(self, chapter_num: int, task_card: dict, scenes: list, assembled_text: str) -> str:
        """CC round-7 P0-3: post-assembly cross-chapter replay gate.

        Stage1 (zero LLM) screens current vs the previous committed chapter; a
        candidate gets one Stage2 LLM four-criterion judgement; a confirmed replay is
        repaired by regenerating the single most-overlapping scene with the previous
        chapter's end_state as a precise negative. Stage2 errors fail OPEN (a legit
        callback must not be killed by infra). If the similarity survives the bounded
        repair it becomes a deterministic hard block so the chapter is isolated, never
        silently published.
        """
        self._boundary_hard = []
        if not scenes or int(chapter_num or 0) <= 1:
            return assembled_text
        prev_path = self.root / "chapters" / "novel" / f"chapter_{chapter_num - 1}.txt"
        if not prev_path.exists():
            return assembled_text
        try:
            prev_text = prev_path.read_text(encoding="utf-8")
        except OSError:
            return assembled_text

        def _assemble() -> str:
            return "\n\n".join((getattr(s, "scene_text", "") or "") for s in scenes)

        cur = _assemble()
        if not cur.strip():
            return assembled_text
        st = stage1_score(cur, prev_text)
        if not st["candidate"]:
            logger.info(f"Boundary Stage1 pass for ch{chapter_num} ({st})")
            return assembled_text
        logger.warning(f"Boundary Stage1 candidate for ch{chapter_num} {st} → Stage2 LLM")

        es = latest_end_state(self.root, chapter_num) or {}
        prompt = build_stage2_prompt(es, prev_text, cur)
        try:
            raw = self.outline_router.chat_completion(
                [{"role": "user", "content": prompt}], temperature=0.0, max_tokens=400)
            content = raw.get("content", "") if isinstance(raw, dict) else str(raw)
            verdict = parse_stage2_verdict(content)
        except Exception as e:  # fail-open: never let judge infra kill a callback chapter
            logger.warning(f"Boundary Stage2 failed-open ({e}); treat as no replay")
            return assembled_text
        if not verdict.get("ok") or not verdict.get("replay"):
            logger.info(f"Boundary Stage2 judged no replay for ch{chapter_num}: {verdict.get('reason', '')}")
            return assembled_text

        scores = scene_overlap_scores(
            {getattr(s, "scene_id", i + 1): (getattr(s, "scene_text", "") or "")
             for i, s in enumerate(scenes)}, prev_text)
        if not scores:
            return assembled_text
        sid = max(scores, key=lambda k: scores[k])
        completed = "、".join(es.get("completed_actions", []) or [])
        position = str(es.get("narrative_position", "") or "")
        pending = "、".join(es.get("pending_actions", []) or []) or "紧接其后的新情节"
        directive = (
            f"上一章已完整演完：{completed}；上一章停在：{position}。"
            "本场景却把这些动作的发生经过重新搬演了一遍（跨章重演）。"
            "本次严禁倒回重演其发生过程，只允许用一两句概括其结果作为承接；"
            f"场景必须直接从“{pending}”或更靠后的新时空节点开场，全部笔墨用于推进新事件。"
        )
        logger.warning(f"Boundary Stage2 confirmed replay for ch{chapter_num}; regen scene {sid}")
        try:
            new_scene = self._regen_scene_for_id(
                task_card, sid, scenes, fix_directive=directive,
                frequency_penalty=0.4, presence_penalty=0.4)
        except Exception as e:
            logger.warning(f"Boundary scene regen failed ({e}); raise hard block")
            self._boundary_hard = [f"[跨章重演] Stage2 判定重演但定点重生失败: {e}"]
            return assembled_text
        for idx, s in enumerate(scenes):
            if getattr(s, "scene_id", None) == sid:
                scenes[idx] = new_scene
        try:
            append_scene(self.root, chapter_num,
                         {"scene_id": sid, "scene_text": new_scene.scene_text,
                          "hook": new_scene.hook, "beats": list(new_scene.beats or [])})
        except Exception as je:
            logger.warning(f"Boundary journal append failed for scene {sid}: {je}")
        self.writer.last_scenes = list(scenes)

        cur2 = _assemble()
        st2 = stage1_score(cur2, prev_text)
        purified2 = purify_novel_for_publish(cur2, chapter_num=chapter_num)
        if st2["candidate"]:
            self._boundary_hard = [
                f"[跨章重演] 定点重生场景{sid}后仍与上一章高度重合 {st2}"]
            logger.warning(f"Boundary still candidate after scene {sid} regen {st2} → hard block")
        else:
            logger.info(f"Boundary resolved after scene {sid} regen {st2}")
        return purified2

    def _stage_review(self, chapter_num: int, task_card: dict, synopsis: dict,
                      novel_text: str, world_state: dict) -> dict:
        """阶段5：审查评分。"""
        # 修复流中会以 REVIEW 状态再次调用本方法，避免无效的 REVIEW->REVIEW 转换报错
        if self.state_machine.current_phase != ChapterPhase.REVIEW:
            self.state_machine.transition(ChapterPhase.REVIEW)
        # CC round-8 P0-3：每次评审入口复位“极不稳定”标记
        self._review_highly_unstable = False
        # CC round-26：单章评审 LLM 调用硬上限（首评/三评/单离群补票/修复后复评合计）。
        # 跨修复轮持续累计、按章复位；超限不再补票，强制走 gap（防补票递归到凑分为止）。
        from novel_engine.quality import review_votes as _rv26mod
        _REVIEW_CALL_CAP26 = int(getattr(_rv26mod, "REVIEW_CALL_CAP", 6))
        if getattr(self, "_review_call_chapter", None) != chapter_num:
            self._review_call_chapter = chapter_num
            self._review_call_count = 0
        # CC P0: 成稿文本不变则复用评审结果（跨进程 infra retry 不二次计费/打分）；
        # 定点重生/重写后文本改变，hash 自动变化而 miss。同进程修复循环内的再评审
        # (本章已读过一次) 绕过缓存读，保留“编辑→再评审”的既有收敛语义。
        review = None
        _rk = None
        _allow_read = chapter_num not in self._review_read_chapters
        self._review_read_chapters.add(chapter_num)
        _was_cache_hit = False
        if _allow_read:
            try:
                _rv_model = model_fingerprint(self.root, "review")
                _rk = content_key(
                    {"novel_text": novel_text, "task_card": task_card,
                     "synopsis": synopsis, "world_state": world_state},
                    version=PROMPT_VERSIONS["review"], model=_rv_model)
                review = self._phase_cache.get(chapter_num, "review", _rk)
                if review is not None:
                    _was_cache_hit = True
                    logger.info(f"Review cache hit for chapter {chapter_num} (identical final text)")
            except Exception as _ce:
                logger.warning(f"review cache read skipped: {_ce}")
                review = None
        # CC round-24 P0-1：真实 LLM 模式下构建零成本确定性信号（推进契约覆盖/单场氛围/
        # 相邻共享/硬门状态），供 reviewer 锚点注入 + pacing/retention 混合分 + 异常票判定。
        # mock/测试模式整体关闭，保持历史评分与既有离线测试不变。
        _real24 = not bool((self.config.get("llm") or {}).get("use_mock"))
        _signals24 = None
        _supplementary_used24 = False
        if _real24:
            try:
                from novel_engine.quality import density_gate as _dg24
                _a24 = _dg24.arc_for_chapter(chapter_num, self.root)
                _sc24 = [{"scene_id": d.get("scene_id"), "scene_text": d.get("scene_text", "") or ""}
                         for d in load_authoritative_scenes(self.root, chapter_num)]
                _hgclean24 = not (getattr(self, "_last_deterministic_issues", [])
                                  or getattr(self, "_boundary_hard", []))
                _signals24 = review_hybrid.build_deterministic_signals(
                    task_card, _sc24, self.root, arc=_a24, hard_gates_clean=_hgclean24)
            except Exception as _e24sig:
                logger.warning(f"deterministic signals build failed-open: {_e24sig}")
                _signals24 = None

        def _one_review24():
            self._review_call_count = int(getattr(self, "_review_call_count", 0)) + 1
            rv = self.reviewer.review_chapter(
                chapter_num=chapter_num, task_card=task_card, synopsis=synopsis,
                novel_text=novel_text, world_state=world_state,
                deterministic_signals=_signals24 if (_real24 and _signals24 is not None) else None)
            if _real24 and _signals24 is not None:
                review_hybrid.annotate_raw_total(rv)
                review_hybrid.hybridize_review(rv, _signals24)
            return rv

        if review is None:
            review = _one_review24()
        score = review.get("normalized_score", review.get("total_score", 0))
        # CC round-7 Q4：首评异常低(<65)且文本已过全部确定性硬门时，同稿确定性复核一次，
        # 取两次最高，避免一次假低分（同稿 58/87/92 那种高方差）触发昂贵返工；分差>20 记不稳定。
        if (
            _allow_read and not _was_cache_hit and isinstance(score, (int, float))
            and 0 < score < 65 and not (getattr(self, "_last_deterministic_issues", []) or [])
        ):
            logger.warning(
                f"ch{chapter_num} first review {score}<65 with no deterministic hard issue "
                "→ deterministic same-text recheck")
            try:
                review2 = _one_review24()
                score2 = review2.get("normalized_score", review2.get("total_score", 0)) or 0
                try:
                    if abs(float(score2) - float(score)) > 20:
                        logger.warning(
                            f"review_unstable ch{chapter_num}: {score} vs {score2} (|gap|>20)")
                except (TypeError, ValueError):
                    pass
                if float(score2) > float(score):
                    review, score = review2, score2
                    logger.info(f"ch{chapter_num} recheck higher → adopt score={score2}")
            except Exception as _re:
                logger.warning(f"review recheck failed-open ({_re}); keep first score")
        # CC round-8 P0-3：首评落入 85-90 近阈值区 → 确定性三评取中位数（同稿同档连调3次）；
        # 三评极差>15 标 review_highly_unstable，无论中位数是否过线都强制人工复核。
        _gate_fired = bool(getattr(self, "_chapter_gate_fired", False))
        # CC round-24 Q5①：确定性指标全绿（硬门 clean + 推进/氛围无违规）时，门即使触发过
        # 修复也不强制三评，首评即可；只有分数落 85-90 带或出现极差才补评。非全绿仍按旧规
        # 门命中即三评。mock 模式沿用旧逻辑（_green24=False）。
        _green24 = _real24 and review_hybrid.signals_all_green(_signals24)
        _force_triple24 = _gate_fired and not _green24
        # CC28/批D 提速：真机用窄灰带 [81.5,85.5] 决定是否三评（>=85.5 且硬门绿→单评免三；
        # <=81.5→不三评直接修复；落带才三评）；门命中且非全绿仍强制三评。mock/测试沿用旧 85-90 带。
        if _real24:
            try:
                from novel_engine.quality import gray_band as _gb28
                _band_triple28 = _gb28.decide_review_count(
                    score, bool(_green24),
                    band=tuple(getattr(self, "_gray_band28", _gb28.INITIAL_BAND)),
                    force_dual=bool(getattr(self, "_gray_force_dual28", False)),
                )["plan"] == _gb28.REVIEW_TRIPLE
            except Exception:
                _band_triple28 = should_run_extra_reviews([score])
        else:
            _band_triple28 = should_run_extra_reviews([score])
        if _allow_read and not _was_cache_hit and _force_triple24 and not _band_triple28:
            logger.warning(f"ch{chapter_num} deterministic gate fired (repaired) -> default triple review despite score={score}")
        if _allow_read and not _was_cache_hit and (_band_triple28 or _force_triple24):
            try:
                votes = [(review, float(score))]
                for _ in range(2):
                    _rv = _one_review24()
                    votes.append((_rv, float(_rv.get("normalized_score", _rv.get("total_score", 0)) or 0)))
                # CC round-24 P0-1(c)：剔除技术性错误票（raw=0 解析失败 / raw>120 越界 /
                # 硬门已证伪却声称拉丁英文泄漏）。有效票不足 2 时不做中位数结论，转不稳定低分。
                if _real24:
                    _hg24 = bool(_signals24 and _signals24.get("hard_gates_all_clean"))
                    _fvotes = review_hybrid.filter_valid_votes(votes, _hg24)
                    if len(_fvotes) >= 2:
                        votes = _fvotes
                    elif _fvotes:
                        logger.error(
                            f"ch{chapter_num} only {len(_fvotes)}/3 valid review vote(s) "
                            f"(others parse/out-of-range) -> unstable, no median conclusion")
                        votes = _fvotes
                _vals = [v[1] for v in votes]
                _agg = aggregate_votes(_vals)
                self._review_highly_unstable = bool(_agg["highly_unstable"])
                _med = float(_agg["median"])
                _chosen = next((rv for rv, sc in votes if abs(sc - _med) < 1e-9), None)
                if _chosen is None and votes:
                    _chosen = sorted(votes, key=lambda x: x[1])[len(votes) // 2][0]
                if not votes:
                    # 三票全部技术无效：无可信分，按 0 分走不稳定 gap（绝不伪达标出版）
                    logger.error(f"ch{chapter_num} all 3 review votes technically invalid -> score 0 gap")
                    self._review_highly_unstable = True
                    score = 0.0
                else:
                    review, score = _chosen, _med
                # CC round-22 P0-3：中位本就<软线 -> 维持 unstable（runner gap-continue）；
                # 中位>=软线却分歧大 -> 追加1次复评，4票取中位：新中位>=软线则清 unstable 走正常
                # 提交/E-loop 流程，<软线则留 unstable 交 runner gap。复评本身异常才保守保留 HALT 兜底。
                if self._review_highly_unstable:
                    if "_med" not in locals():
                        _med = float(score)
                    try:
                        _soft5 = int(load_quality_policy(self.root).get("soft_publication_line", 85))
                    except Exception:
                        _soft5 = 85
                    # ── CC round-26：单离群崩票识别 + 恰好1次补票收敛（最重要原则修正）──
                    # 旧逻辑：极差>15 即 unstable，中位<软线直接 gap、跳过整个 E-loop/文学性修订。
                    # 新逻辑：三票呈"一张离群+两票紧簇"时，补 1 票交叉验证：
                    #   新票落入紧簇±8 → 确认离群票是崩票，用[紧簇两票+新票]取中位、清除 unstable，
                    #     即使中位<软线也照常进入 E-loop/文学性修订并重新评审（内容不达标≠评审不可信）；
                    #   新票不收敛 → 维持 unstable 走 gap。真三分布分裂(true_split)不走本块，维持人工。
                    _pat26 = str((_agg or {}).get("pattern", ""))
                    _cluster26 = list((_agg or {}).get("cluster") or [])
                    _outlier26 = (_agg or {}).get("outlier")
                    _cc26_outlier_attempted = False
                    if (_real24
                            and _pat26 in ("single_outlier_low", "single_outlier_high")
                            and len(_cluster26) == 2
                            and not _supplementary_used24
                            and self._review_call_count < _REVIEW_CALL_CAP26):
                        _cc26_outlier_attempted = True
                        _cluster_pairs26 = [p for p in votes
                                            if any(abs(p[1] - float(cv)) < 1e-9 for cv in _cluster26)]
                        _outlier_rv26 = next((rv for rv, scx in votes
                                              if _outlier26 is not None and abs(scx - float(_outlier26)) < 1e-9),
                                             None)
                        try:
                            _supplementary_used24 = True
                            _rv26 = _one_review24()
                            _valid26 = review_hybrid.is_valid_vote(_rv26) \
                                and not review_hybrid.dim_sum_mismatch(_rv26)
                            if not _valid26:
                                logger.warning(
                                    f"ch{chapter_num} CC26 outlier-check supplementary vote invalid; "
                                    f"keep unstable (pattern={_pat26}) -> gap")
                            else:
                                _s26 = float(_rv26.get("normalized_score",
                                                       _rv26.get("total_score", 0)) or 0)
                                # 三类矛盾特征仅作辅助佐证（绝不单独丢票），落日志供回溯。
                                try:
                                    _feats26 = review_hybrid.vote_anomaly_features(
                                        _outlier_rv26 or {}, _signals24,
                                        ending_text=(novel_text or "")[-400:])
                                    _hits26 = [k for k, v in _feats26.items() if v]
                                    if _hits26:
                                        logger.info(
                                            f"ch{chapter_num} CC26 outlier vote {float(_outlier26):.1f} "
                                            f"auxiliary contradiction features: {_hits26}")
                                except Exception:
                                    pass
                                if _rv26mod.supplementary_converges(_cluster26, _s26):
                                    _pairs26 = _cluster_pairs26 + [(_rv26, _s26)]
                                    _vals26 = [sc26 for _, sc26 in _pairs26]
                                    _agg26 = aggregate_votes(_vals26)
                                    _med26 = float(_agg26["median"])
                                    _chosen26 = next(
                                        (rv26 for rv26, sc26 in _pairs26 if abs(sc26 - _med26) < 1e-9),
                                        None)
                                    if _chosen26 is None and _pairs26:
                                        _chosen26 = sorted(_pairs26, key=lambda x: x[1])[
                                            len(_pairs26) // 2][0]
                                    review = _chosen26 or review
                                    score = _med26
                                    _med = _med26
                                    _vals = _vals26
                                    _agg = _agg26
                                    self._review_highly_unstable = False
                                    logger.warning(
                                        f"ch{chapter_num} CC26 single-outlier resolved: votes={_vals} "
                                        f"(discarded crash vote {float(_outlier26):.1f}, supplementary "
                                        f"{_s26:.1f} converged) -> median={_med26:.2f}, unstable cleared; "
                                        f"proceed to normal E-loop/commit routing")
                                else:
                                    logger.warning(
                                        f"ch{chapter_num} CC26 single-outlier NOT confirmed: supplementary "
                                        f"{_s26:.1f} outside cluster {_cluster26} tol; keep unstable -> gap")
                        except Exception as _e26:
                            logger.warning(
                                f"ch{chapter_num} CC26 outlier-check failed-open; keep unstable: {_e26}")
                    # 旧 rescue/bias 补充票：单离群块已用掉唯一补充票、或已达调用上限时不再追加。
                    _legacy_supp_ok26 = (
                        not _cc26_outlier_attempted
                        and bool(self._review_highly_unstable)
                        and self._review_call_count < _REVIEW_CALL_CAP26)
                    if _legacy_supp_ok26:
                        _rescue4 = _med >= _soft5
                        # CC round-24 P0-1(c)：中位<软线但确定性信号全绿 -> 疑似评审偏严，
                        # 追加恰好 1 次交叉验证（与救援共用唯一一次补充票，每章至多 1 次）。
                        _bias4 = (_real24 and _green24
                                  and review_hybrid.diagnose_low_score(
                                      _med, _signals24, _soft5) == "suspected_reviewer_bias")
                    else:
                        _rescue4 = False
                        _bias4 = False
                    if _rescue4 or _bias4:
                        def _pick_pair(pairs, target):
                            w = next((rv for rv, sc in pairs if abs(sc - target) < 1e-9), None)
                            if w is None and pairs:
                                w = sorted(pairs, key=lambda x: x[1])[len(pairs) // 2][0]
                            return w or review
                        try:
                            _supplementary_used24 = True
                            _rv4 = _one_review24()
                            _valid4 = (not _real24) or review_hybrid.is_valid_vote(_rv4)
                            if not _valid4:
                                logger.warning(
                                    f"ch{chapter_num} supplementary vote technically invalid; "
                                    f"keep median={_med:.2f}")
                                _med4, _ch4 = _med, review
                            else:
                                _s4 = float(_rv4.get("normalized_score", _rv4.get("total_score", 0)) or 0)
                                _vals4 = _vals + [_s4]
                                _med4_raw = float(aggregate_votes(_vals4)["median"])
                                _pairs4 = votes + [(_rv4, _s4)]
                                if _rescue4:
                                    # CC round-23：追加复评是“救援”不是“否决”——第4票不得把
                                    # 三票中位已达标章往下拉，取 max(三票中位, 四票中位)。
                                    _med4 = max(_med, _med4_raw)
                                    if _med4 == _med and _med4_raw < _med:
                                        _ch4 = _chosen if "_chosen" in locals() else review
                                        logger.warning(
                                            f"ch{chapter_num} supplementary 4th review {_s4:.1f} lower "
                                            f"(raw4med={_med4_raw:.2f}); rescue floor keeps median={_med:.2f}")
                                    else:
                                        _ch4 = _pick_pair(_pairs4, _med4)
                                else:
                                    # 偏严交叉验证：诚实采纳新中位；多数票仍低则交 runner gap。
                                    _med4 = _med4_raw
                                    _ch4 = _pick_pair(_pairs4, _med4)
                                logger.warning(
                                    f"ch{chapter_num} supplementary review ({'rescue' if _rescue4 else 'bias-crosscheck'}): "
                                    f"votes={[round(v, 1) for v in _vals4]} raw4med={_med4_raw:.2f} "
                                    f"adopted={_med4:.2f}")
                            review, score = _ch4, _med4
                            self._review_highly_unstable = bool(_med4 < _soft5)
                        except Exception as _se4:
                            logger.warning(
                                f"supplementary review failed-open ch{chapter_num}; keep "
                                f"median={_med} unstable: {_se4}")
                if "_med" not in locals():
                    _med = float(score)
                logger.warning(
                    f"ch{chapter_num} median-of-3 votes={_vals} median={_med} "
                    f"range={_agg['range']} highly_unstable={self._review_highly_unstable}")
            except Exception as _ve:
                logger.warning(f"median-of-3 review failed-open ({_ve}); keep first score {score}")
        # CC round-24 P0-1(c)：未触发三评的“单评 + 确定性全绿但分数<软线”场景，做恰好 1 次
        # 交叉验证（每章至多 1 次补充票）；新中位仍低则诚实保留低分，交 runner gap，不伪达标。
        if (_real24 and _signals24 is not None and _allow_read and not _was_cache_hit
                and not _supplementary_used24):
            try:
                _softb = int(load_quality_policy(self.root).get("soft_publication_line", 85))
            except Exception:
                _softb = 85
            if (isinstance(score, (int, float)) and float(score) < _softb
                    and not getattr(self, "_review_highly_unstable", False)
                    and review_hybrid.signals_all_green(_signals24)):
                try:
                    _rvb = _one_review24()
                    if review_hybrid.is_valid_vote(_rvb):
                        _sb = float(_rvb.get("normalized_score", _rvb.get("total_score", 0)) or 0)
                        _medb = float(aggregate_votes([float(score), _sb])["median"])
                        _chb = _rvb if abs(_sb - _medb) < 1e-9 else review
                        logger.warning(
                            f"ch{chapter_num} green-but-low single review {float(score):.1f}; "
                            f"one crosscheck vote {_sb:.1f} -> median {_medb:.2f}")
                        review, score = _chb, _medb
                except Exception as _eb:
                    logger.warning(f"green-low crosscheck failed-open ch{chapter_num}: {_eb}")
        # 首次成稿评审才落缓存（修复循环 _rk=None 不写，避免 review_None 噪声）
        if not _was_cache_hit and _rk:
            try:
                self._phase_cache.set(chapter_num, "review", _rk, review)
            except Exception:
                pass
        if score <= 0:
            logger.warning("Review parse returned non-positive score for ch" + str(chapter_num))
        if 0 < score < 60:
            logger.warning("Review score unusually low for ch" + str(chapter_num) + " score=" + str(score))
        verdict = self.reviewer.grade_review(review)
        self._last_review_score = score  # Store for commit stage
        logger.info(f"Chapter {chapter_num} review: normalized_score={score}, verdict={verdict}")
        return {"review": review, "score": score, "verdict": verdict,
                "review_unstable": bool(getattr(self, "_review_highly_unstable", False))}

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
        _structured_chapter = bool(getattr(self, "_chapter_structured", False))
        if cur < target_min and not _structured_chapter:
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
        if "（章末钩子" not in novel and hook_text and not _structured_chapter:
            # 仅当原文无 hook 时补，当前 purified 已无 hook 标记，补一个叙事化收束而非标记
            if len(novel) < target_min:
                novel = novel.rstrip() + "\n\n夜色渐深，远处传来隐约的声响，预示着新的变局将至。"
        if _structured_chapter and cur < target_min:
            # CC round-9：结构化章已由场景级篇幅地板处理；软下限不足也不再整章续写，
            # 避免无约束续写把 scope 门删掉的越界内容/天亮时间锚重新写回（软下限不硬凑）。
            logger.info(f"Structured chapter below soft min ({cur} < {target_min}); accept scene-floor length, no whole-chapter continuation")
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

        def _as_int(x):
            try:
                return int(x)
            except (TypeError, ValueError):
                return None

        # E 包：优先使用 reviewer 结构化扣分归因 scene_ids，并为每个场景聚合针对性返工指令
        target_nums: set[int] = set()
        scene_dirs: dict[int, list[str]] = {}
        for iss in (review.get("issues") or []):
            raw_sids = iss.get("scene_ids") if isinstance(iss.get("scene_ids"), list) else []
            sids = [n for n in (_as_int(x) for x in raw_sids) if n is not None]
            if not sids:
                continue
            dim = iss.get("dimension", "")
            sev = iss.get("severity", "")
            desc = str(iss.get("description", "")).strip()
            sfix = str(iss.get("suggested_fix", "")).strip()
            line = f"[{dim}/{sev}] {desc}" + (f" → 修复要求：{sfix}" if sfix else "")
            for sid in sids:
                if sid >= 1:
                    target_nums.add(sid)
                    scene_dirs.setdefault(sid, []).append(line)
        # 兜底：旧 reviewer 未给结构化 scene_ids 时，回退 fix_scope / 文本中的场景号
        if not target_nums:
            for m in re.finditer(r"(?:场景|scene)[\s_]*(\d+)", fix_scope, flags=re.I):
                n = _as_int(m.group(1))
                if n is not None:
                    target_nums.add(n)
        if not target_nums:
            for iss in (review.get("issues") or []):
                txt = f"{iss.get('description','')} {iss.get('suggested_fix','')}"
                for m in re.finditer(r"场景\s*(\d+)", txt):
                    n = _as_int(m.group(1))
                    if n is not None:
                        target_nums.add(n)
        if not target_nums:
            return None
        # 仅处理 1-2 个场景的局部问题，避免全章重写；纯全局性问题（无场景归因）不在此处理
        if len(target_nums) > 2:
            return None
        # CC round-23 P0-2：节奏/留存/情节类低分 -> E-loop 必须"补具体事件"而非润色措辞。
        # CC round-25 P0-2：hook（钩子张力）/innovation（去套路）/style/cliff（场末悬崖感）已从
        # 逐场补事件中移除，改由整章一次性文学性重写处理——补事件既不对症文字问题、还扰动情节。
        _density_dims = {"pacing", "retention", "plot"}
        _density_sids = set()
        # CC round-25 修正（r30 实测降分）：若低分原因是"信息重复/台词重叠/拖沓"，正确修法是
        # 删减合并而非新增事件；记录这些场，fallback 指令改为去重（避免越'补'越拖、分数反降）。
        _rep_re = __import__("re").compile(r"重复|重叠|拖沓|冗余|雷同|啰嗦|反复|赘述")
        _rep_sids = set()
        for iss in (review.get("issues") or []):
            _dimv = str(iss.get("dimension", "")).lower()
            _txtv = f"{iss.get('description', '')} {iss.get('suggested_fix', '')}"
            for _x in (iss.get("scene_ids") or []):
                try:
                    _xn = int(_x)
                except (TypeError, ValueError):
                    continue
                if _dimv in _density_dims:
                    _density_sids.add(_xn)
                    if _rep_re.search(_txtv):
                        _rep_sids.add(_xn)
        try:
            from novel_engine.quality import scene_progression_gate as _spg23
            _prog_cfg = _spg23.load_progression_config(self.root)
            _metrics = getattr(self, "_scene_progression_metrics", {}) or {}
            for _sid in sorted(target_nums):
                # 有明确密度问题场景归因时只补那些场；否则（全局性节奏薄弱）所有目标场都补
                if _density_sids and _sid not in _density_sids:
                    continue
                _m = _metrics.get(_sid, {}) or {}
                _miss = _m.get("missing_new_state") or []
                _ratio = _m.get("atmosphere_ratio")
                _parts = []
                if _miss:
                    _parts.append(_spg23.new_state_directive(
                        {"detail": {"missing_new_state": [{"desc": _d} for _d in _miss]}}))
                if isinstance(_ratio, (int, float)) and _ratio >= 0.4:
                    _parts.append(_spg23.atmosphere_ratio_directive(
                        float(_ratio), float(_prog_cfg.get("scene_atmosphere_ratio", 0.55))))
                if not _parts:
                    if _sid in _rep_sids:
                        _parts.append(
                            "审查判定本场存在信息重复/台词重叠/节奏拖沓。请【删减合并】："
                            "删除反复强调同一信息的台词与近义句，把重叠对话压成一次有信息量的交锋，"
                            "用省出的篇幅补一个此前未出现的具体动作或反应（不改变既定事件与走向），"
                            "总字数基本保持不变；严禁再新增同类重复信息或再渲染气氛。")
                    else:
                        _parts.append(
                            "审查判定本场情节推进/留存薄弱。请【新增】一个此前在本章未出现过的"
                            "具体动作、对话或信息揭示（不是润色措辞、不是再渲染雾/寒/气氛），"
                            "让故事实质向前走一步；删除等量重复氛围描写，总字数基本保持不变。")
                scene_dirs.setdefault(_sid, []).extend(_parts)
        except Exception as _e23:
            logger.warning(f"Progression E-loop directive skipped: {_e23}")
        blueprints = {bp.get("scene_num"): bp for bp in (task_card.get("scene_blueprints") or [])}
        ch = int(chapter_num or (task_card.get("chapter_num", 0) or 0))
        try:
            journal = {d["scene_id"]: d.get("scene_text", "")
                       for d in load_authoritative_scenes(self.root, ch)}  # CC19 Q2
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
        # 单场景定点重生预算：每个 (章,场景) 最多 2 次（CC E 包），耗尽则不再重生，交由终态判定（隔离转人工，不硬凑）
        budget = getattr(self, "_scene_regen_used", None)
        if budget is None:
            budget = {}
            self._scene_regen_used = budget
        SCENE_REGEN_MAX = 2
        regenerated = False
        patched_ids: set[int] = set()
        patched_outs: dict[int, tuple] = {}
        for sn in sorted(target_nums):
            bp = blueprints.get(sn)
            if not bp:
                continue
            used = budget.get((ch, sn), 0)
            if used >= SCENE_REGEN_MAX:
                logger.warning(f"Scene {sn} chapter {ch} exhausted targeted regen budget ({SCENE_REGEN_MAX}); leave to terminal decision, no padding")
                continue
            directive = "\n".join(f"- {ln}" for ln in scene_dirs.get(sn, [])) or ""
            # CC round-18 P0-2：修订不得让场景缩水——删冗余后须补等量新正文，净字数保持±15%
            _orig_len = len(journal.get(sn, "") or "")
            directive += (
                "\n- 字数保持（硬性）：删除冗余/重复后必须在本场景内补写等量的新正文"
                "（感官细节/环境描写/角色反应，不得新增情节事件），使修订后本场景字数"
                f"不显著低于原稿（原稿约{_orig_len}字，净变化控制在±15%以内，目标不短于约"
                f"{int(_orig_len * 0.85)}字）；严禁只删不补、严禁因修订让场景大幅缩短。"
            )
            directive = directive.strip() or None
            try:
                new_scene_out = self.writer.generate_scene(task_card, bp, synopsis_text, "", "", fix_directive=directive)
                # B2：generate_scene 返回 SceneOutput；热插拔缝合的是纯叙事 scene_text
                new_scene = new_scene_out.scene_text if hasattr(new_scene_out, "scene_text") else new_scene_out
            except Exception as e:
                logger.warning(f"Incremental patch scene {sn} generation failed: {e}")
                return None
            budget[(ch, sn)] = used + 1
            journal[sn] = new_scene.strip() if isinstance(new_scene, str) else new_scene
            regenerated = True
            patched_ids.add(sn)
            patched_outs[sn] = (new_scene_out, new_scene)
        if not regenerated:
            return None
        # Journal write-back：被 patch 的 scene_id 即刻回写 journal（append 即 update，
        # load 侧 dict 后写覆盖先写），使 journal 在多轮 fix loop 中保持为真正的
        # source of truth；否则 round-2 patch 会从陈旧落盘复活原文，丢弃 round-1 增益。
        for sn in sorted(patched_ids):
            try:
                new_scene_out, new_scene = patched_outs.get(sn, (None, journal.get(sn, "")))
                beats = list(getattr(new_scene_out, "beats", []) or []) or extract_beats_fallback(new_scene)
                append_scene(self.root, ch, {"scene_id": sn, "scene_text": journal[sn],
                                             "hook": getattr(new_scene_out, "hook", ""), "beats": beats})
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
            existing = load_authoritative_scenes(self.root, chapter_num)  # CC19 Q2
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
                                                      "hook": "", "beats": extract_beats_fallback(text)})
            except Exception as je:
                logger.warning(f"Journal write-back failed for chapter {chapter_num} scene {sid}: {je}")

    def _cc25_literary_rewrite(self, current: str, review: dict, task_card: dict,
                               synopsis: dict, chapter_num: int):
        """CC round-25 P0-2：整章一次性、聚焦 hook/style/innovation 的定向文学性重写。

        一次 LLM 调用产出少量"锚点替换"，确定性缝进对应场景；缝入后重跑全部确定性门，
        门不过整体弃用（journal 不动）。成功返回 (purified_current, draft_with_markers)，
        否则 None。下一轮 fix loop 顶部的 _stage_review 即"必须的重新评审"。
        """
        try:
            if (self.config.get("llm") or {}).get("use_mock"):
                return None
        except Exception:
            pass
        from novel_engine.agents import literary_pass as _lp25
        issues = _lp25.select_literary_issues(review)
        try:
            _auth = load_authoritative_scenes(self.root, chapter_num)
        except Exception as _e:
            logger.warning(f"CC25 literary pass abort: load scenes ch{chapter_num}: {_e}")
            return None
        texts = {int(d["scene_id"]): (d.get("scene_text", "") or "") for d in _auth}
        if not texts:
            return None
        ordered = sorted(texts)
        prompt = _lp25.build_literary_prompt(
            [(sid, texts[sid]) for sid in ordered], issues, chapter_num)
        try:
            resp = self.polish_router.chat_completion(
                [{"role": "system", "content": _lp25.SYSTEM_PROMPT},
                 {"role": "user", "content": prompt}],
                temperature=0.8, max_tokens=8192)
        except Exception as _e:
            logger.warning(f"CC25 literary pass request failed ch{chapter_num}: {_e}")
            return None
        raw = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        edits = _lp25.parse_literary_edits(raw)
        if not edits:
            logger.info(
                f"CC25 literary pass ch{chapter_num}: no valid edits parsed; raw head: "
                f"{(raw or '')[:400]!r}")
            return None
        logger.info(
            f"CC25 literary pass ch{chapter_num}: parsed {len(edits)} edits "
            f"{[(e['scene_id'], e['op'], len(e['replacement'])) for e in edits]}")
        new_texts, applied, notes = _lp25.apply_literary_edits(texts, edits)
        if not applied:
            logger.info(f"CC25 literary pass ch{chapter_num}: 0 edits applied: {notes}")
            return None
        rebuilt = "\n\n※\n\n".join(new_texts[k] for k in ordered)
        try:
            cand = purify_novel_for_publish(rebuilt, chapter_num=chapter_num)
        except Exception:
            cand = rebuilt
        frozen = self._frozen_task_cards.get(chapter_num, task_card)
        total = sum(self._bpt(bp) for bp in (frozen.get("scene_blueprints") or []))
        if total > 0:
            _pol = load_quality_policy(self.root)
            cand = self._enforce_word_count(
                cand,
                int(total * _pol["min_ratio"]),
                int(total * _pol["max_ratio"] + max(_pol["tolerance_chars"], total * 0.02)))
        gate = self._deterministic_quality_gate(cand, frozen)
        if not gate.get("passed"):
            logger.warning(
                f"CC25 literary pass ch{chapter_num} rejected: deterministic gates fail "
                f"{gate.get('issues')} (journal untouched)")
            return None
        # 门过才回写 journal（只写被改场，保留为 source of truth；topup 不进 journal）
        from novel_engine.pipeline.chapter_journal import append_scene
        for sid in ordered:
            if new_texts[sid] != texts.get(sid, ""):
                try:
                    append_scene(self.root, chapter_num, {
                        "scene_id": sid, "scene_text": new_texts[sid], "hook": "",
                        "beats": extract_beats_fallback(new_texts[sid])})
                except Exception as je:
                    logger.warning(f"CC25 literary journal write-back ch{chapter_num} s{sid}: {je}")
        logger.warning(f"CC25 literary pass ch{chapter_num} applied {applied} edits: {notes}")
        return cand, rebuilt

    def _rewrite_weak_dimensions(self, novel, review):
        from novel_engine.agents.reviewer_agent import DIM_MAX
        scores = review.get("scores") or {}
        weak = [k for k, v in scores.items() if (v / DIM_MAX.get(k, 10)) < 0.85]
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
        return call_llm(prompt, system_prompt="你是资深小说润色编辑，擅长根据审查意见精准改写章节（保持或缩短，不增字）", output_json=False, client=self.refine_router)

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
        """Fail-closed Chinese hard gate: any Latin leak triggers LLM repair via outline router.

        Calls ensure_chinese_hard_gate with self.outline_router as the text fixer.
        Pass-through (no LLM call) when text is already clean.
        """
        from novel_engine.quality.chinese_gate import ensure_chinese_hard_gate
        text = self._novel_string(novel)
        fixed = ensure_chinese_hard_gate(
            text=text,
            llm_client=self.outline_router,
            root=self.root,
        )
        if hasattr(novel, "content"):
            novel.content = fixed
            return novel
        return fixed

    def _forbidden_violations(self, novel, review_text=""):
        text = getattr(novel, "content", None)
        if text is None:
            text = novel if isinstance(novel, str) else str(novel)
        out = []
        text = purify_novel_for_publish(text)
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
            # CC round-7 P0-2：质量类整章重采不在进程内用同一任务卡反复重试，直接交 runner/看门狗
            # CC round-19/20/21：终检硬阻断 / 时序 gap / 质量留 gap 同样是确定性终局隔离，
            # runner 会 gap-continue；绝不在进程内整章重排重试（否则每章多烧一整遍 LLM）。
            if result.get("final_gate_blocked") or result.get("quality_gap_continue"):
                logger.warning(
                    f"Chapter {chapter_num} terminal quality gap "
                    f"(final_gate={bool(result.get('final_gate_blocked'))}, "
                    f"continuity/quality={bool(result.get('quality_gap_continue'))}) "
                    "-> skip in-process retries, runner gap-continues")
                return result
            if result.get("quality_replan"):
                logger.warning(
                    f"Chapter {chapter_num} quality-replan requested "
                    f"(scenes={result.get('replan_scene_ids')}) → skip in-process retries")
                return result
            if result.get("success") or result.get("pending_human_review"):
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

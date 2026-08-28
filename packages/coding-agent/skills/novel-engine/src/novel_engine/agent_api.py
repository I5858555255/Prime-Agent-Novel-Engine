"""
Agent-callable API surface for the novel-engine Prime-Agent skill.

Prime-Agent pre-imports this package as ``novel_engine`` inside the persistent
IPython kernel. The agent loop invokes these coroutines via
``await novel_engine.<fn>(...)``.

They are thin wrappers over :class:`PipelineOrchestrator` (the same engine the
standalone ``production_runner.py`` drives). ``project_root`` lets a caller
point at a different novel project (e.g. a sandbox copy); it defaults to this
skill directory, which *is* the novel project (config/, bible/, chapters/,
runtime/ all live under ``src/novel_engine/``).
"""
import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("novel_engine.agent_api")

ROOT = Path(__file__).parent  # src/novel_engine


def _load_env_if_present():
    """Load a local .env into os.environ (Prime-Agent does not do this for us).

    The orchestrator reads ZLEAP_MODEL_API_KEY / AGNES_API_KEY from the env, so
    we parse a sibling .env to make the skill self-contained inside the kernel.
    """
    for candidate in (ROOT / ".env", ROOT.parent / ".env"):
        if candidate.exists():
            try:
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip().strip('"').strip("'")
                    os.environ.setdefault(key, val)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Failed to parse .env at %s: %s", candidate, exc)
            return


def _build_orchestrator(project_root=None, use_mock=False):
    _load_env_if_present()
    from novel_engine.pipeline.pipeline_orchestrator import PipelineOrchestrator
    from novel_engine.core.llm_client import MockLLMClient

    root = str(project_root or ROOT)
    if use_mock:
        return PipelineOrchestrator(root, llm_client=MockLLMClient())
    return PipelineOrchestrator(root)


async def init_state(config_path=None, reset=False, project_root=None):
    """Initialize / load world state and return a status dict.

    Call once before generating. If ``reset`` is True the runtime state is
    cleared and characters/relationships are re-seeded (use with care — this
    wipes generated state; never call while a production run is active).
    """
    if reset:
        _load_env_if_present()
        from novel_engine.pipeline.reset_state import reset_runtime_state
        reset_runtime_state(Path(project_root or ROOT))
    orch = _build_orchestrator(project_root)
    char_path = Path(project_root or ROOT) / "memory" / "world_state" / "characters.json"
    if not char_path.exists():
        from novel_engine.pipeline.init_state import init_characters
        init_characters(Path(project_root or ROOT))
    return {
        "status": "ready",
        "project_root": str(project_root or ROOT),
        "current_chapter": orch.state_machine.current_chapter,
    }


async def generate_chapter(chapter_num: int, project_root=None, use_mock=False):
    """Generate (and commit) a single chapter end-to-end.

    Reuses the full pipeline: world-sim → director → synopsis → write →
    review → self-heal → commit. Returns the pipeline result dict
    ``{"chapter", "success", "score", "errors"}``.
    """
    orch = _build_orchestrator(project_root, use_mock=use_mock)
    ch = int(chapter_num)
    try:
        result = orch._run_with_retry(ch)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("generate_chapter(%s) failed", ch)
        return {"chapter": ch, "success": False, "score": None, "errors": [str(exc)]}
    return result


async def review_chapter(chapter_num: int, project_root=None, use_mock=False):
    """Score an already-committed chapter via the independent review model.

    Returns ``{"chapter", "score", "verdict", "review"}``.
    """
    orch = _build_orchestrator(project_root, use_mock=use_mock)
    ch = int(chapter_num)
    novel_path = Path(project_root or ROOT) / "chapters" / "novel" / f"chapter_{ch}.txt"
    syn_path = Path(project_root or ROOT) / "chapters" / "synopsis" / f"chapter_{ch}.txt"
    out_path = Path(project_root or ROOT) / "chapters" / "outline" / f"chapter_{ch}.json"
    if not (novel_path.exists() and syn_path.exists() and out_path.exists()):
        return {"chapter": ch, "success": False, "error": "chapter files not found; generate first"}
    novel_text = novel_path.read_text(encoding="utf-8")
    synopsis = json.loads(syn_path.read_text(encoding="utf-8"))
    task_card = json.loads(out_path.read_text(encoding="utf-8"))
    world_state = orch.simulator.build_world_state_for_chapter(ch)
    review = orch.reviewer.review_chapter(
        chapter_num=ch, task_card=task_card, synopsis=synopsis,
        novel_text=novel_text, world_state=world_state,
    )
    score = review.get("total_score", 0)
    verdict = orch.reviewer.grade_review(review)
    return {"chapter": ch, "score": score, "verdict": verdict, "review": review}


async def self_heal(chapter_num: int, project_root=None, use_mock=False):
    """Apply the self-healing / remediation loop to a generated chapter.

    Phase 1 implements this as a re-run of the orchestrator's built-in
    fix/rollback path for ``chapter_num``. (Phase 3 upgrades the critic to emit
    a structured code-level Incremental Patch.)
    """
    orch = _build_orchestrator(project_root, use_mock=use_mock)
    ch = int(chapter_num)
    try:
        result = orch.generate_single_chapter(ch)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("self_heal(%s) failed", ch)
        return {"chapter": ch, "success": False, "errors": [str(exc)]}
    return result


async def branch_compare(chapter_num: int, variants: int = 2, project_root=None, use_mock=False):
    """Generate ``variants`` candidate chapters and keep the best by review score.

    Phase 1 heuristic: each variant is generated on a rolled-back world state;
    the highest-scoring draft is re-committed. (Phase 2 replaces this with
    Prime-Agent durable branching sessions / ``--fork``.)
    """
    orch = _build_orchestrator(project_root, use_mock=use_mock)
    ch = int(chapter_num)
    best = None
    for _ in range(int(variants)):
        try:
            res = orch.generate_single_chapter(ch)
        except Exception:
            continue
        score = res.get("score")
        if best is None or (score is not None and score > best.get("score", -1)):
            best = res
        orch._rollback_world_to(ch - 1)
    if best is not None and best.get("success"):
        orch.generate_single_chapter(ch)  # re-commit the winning variant
    return best or {"chapter": ch, "success": False, "error": "no variant succeeded"}


async def commit(chapter_num: int, project_root=None):
    """Idempotent finalize: verify a chapter's artifacts are committed.

    ``generate_chapter`` already commits; this is an explicit check for
    agent-driven flows. Returns ``{"chapter", "committed"}``.
    """
    ch = int(chapter_num)
    paths = [
        Path(project_root or ROOT) / "chapters" / "novel" / f"chapter_{ch}.txt",
        Path(project_root or ROOT) / "chapters" / "synopsis" / f"chapter_{ch}.txt",
        Path(project_root or ROOT) / "chapters" / "outline" / f"chapter_{ch}.json",
    ]
    ok = all(p.exists() for p in paths)
    return {"chapter": ch, "committed": ok}


# ---------------------------------------------------------------------------
# Phase 2: RLM recursive subagents + durable branching (Prime-Agent kernel)
# ---------------------------------------------------------------------------
# The pipeline itself is synchronous, but Prime-Agent's `rlm('sub-task')` is
# async. So the RLM fan-out is driven from an async entrypoint below, not
# injected into the sync writer. When no `rlm` handle is present (standalone
# production run, or a kernel where handles were not injected), every Phase-2
# entrypoint degrades to the standard synchronous pipeline — so the standalone
# run is never affected.

_KERNEL = {"rlm": None, "agent_message": None}


async def set_kernel_handles(rlm=None, agent_message=None):
    """Inject the Prime-Agent kernel handles (called by the agent once per session).

    Usage (inside the kernel)::
        await novel_engine.set_kernel_handles(rlm=rlm, agent_message=agent_message)
    """
    _KERNEL["rlm"] = rlm
    _KERNEL["agent_message"] = agent_message
    return {"status": "kernel handles set", "rlm": rlm is not None}


async def generate_scene_unit(
    chapter_num: int,
    scene_index: int,
    task_card: dict,
    synopsis: dict,
    scene_blueprint: dict,
    pacing_constraints: str = "",
    temperature_override=None,
    project_root=None,
    use_mock=False,
):
    """Generate a SINGLE scene. This is the unit an RLM subagent produces.

    Returns the scene text (str). A subagent spawned via ``rlm('sub-task')``
    calls this and sends the result back over ``agent_message``.
    """
    orch = _build_orchestrator(project_root, use_mock=use_mock)
    content = orch.writer.generate_scene(
        task_card, scene_blueprint, synopsis.get("synopsis", ""),
        "", pacing_constraints, temperature_override,
    )
    return content


def _assemble_chapter(scene_contents: dict, task_card: dict) -> str:
    """Build full chapter text from a {scene_num: content} map (mirrors writer)."""
    parts = []
    for scene_num in sorted(scene_contents):
        content = scene_contents[scene_num]
        bp = next(
            (b for b in task_card.get("scene_blueprints", [])
             if b.get("scene_num") == scene_num), {})
        location = bp.get("location", "")
        parts.append(f"【场景{scene_num}：{location}】\n\n{content}\n\n※\n")
    full = "\n".join(parts)
    hook = task_card.get("chapter_hook", "")
    if hook:
        full += f"\n\n---\n*（章末钩子：{hook}）*"
    return full


async def generate_chapter_with_subagents(chapter_num: int, project_root=None, use_mock=False):
    """Generate a chapter using Prime-Agent RLM subagents for scene groups.

    If ``rlm`` was injected via :func:`set_kernel_handles`, each independent
    scene group is generated by a spawned subagent (calling
    ``generate_scene_unit``); results are assembled and the standard
    review/commit path finalizes the chapter. If ``rlm`` is absent, this
    degrades to :func:`generate_chapter` (standard synchronous pipeline).
    """
    rlm = _KERNEL.get("rlm")
    agent_message = _KERNEL.get("agent_message")
    ch = int(chapter_num)

    if rlm is None:
        return await generate_chapter(ch, project_root=project_root, use_mock=use_mock)

    orch = _build_orchestrator(project_root, use_mock=use_mock)
    try:
        world_state = orch._stage_world_sim(ch)
        task_card = orch._stage_directing(ch, world_state)
        synopsis = orch._stage_synopsis(task_card)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Phase-2 prep failed (%s); fallback to standard pipeline", exc)
        return await generate_chapter(ch, project_root=project_root, use_mock=use_mock)

    scenes = task_card.get("scene_blueprints", [])
    groups = orch.writer._group_independent_scenes(scenes)
    scene_contents: dict = {}

    try:
        for group in groups:
            handle = await rlm("sub-task")  # admission returns child handle immediately
            spec = {
                "chapter_num": ch,
                "task_card": task_card,
                "synopsis": synopsis,
                "scene_blueprints": group,
                "pacing_constraints": "",
            }
            await agent_message.send(
                content=json.dumps(spec), receiver_role="child", receiver_name=handle.name)
            reply = await agent_message.recv(receiver_role="parent")
            for bp, content in reply:
                scene_contents[bp.get("scene_num")] = content
    except Exception as exc:  # pragma: no cover - defensive (kernel API uncertainty)
        logger.warning("RLM dispatch failed (%s); fallback to standard pipeline", exc)
        return await generate_chapter(ch, project_root=project_root, use_mock=use_mock)

    full = _assemble_chapter(scene_contents, task_card)
    orch.current_novel = full
    try:
        staged = orch._stage_review(ch, task_card, synopsis, full, world_state)
        score = staged["score"]
        verdict = staged["verdict"]
        orch.state_machine.commit_chapter(
            chapter_num=ch,
            novel_content=full,
            synopsis_content=json.dumps(synopsis, ensure_ascii=False),
            outline_content=json.dumps(task_card, ensure_ascii=False),
            world_state_snapshot=world_state,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Phase-2 finalize failed")
        return {"chapter": ch, "success": False, "errors": [f"finalize: {exc}"]}

    return {"chapter": ch, "success": verdict == "pass", "score": score}

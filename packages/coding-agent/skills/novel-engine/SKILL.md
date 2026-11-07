---
name: novel-engine
description: Generate, review, and self-heal long-form web-novel chapters with a deterministic world-state pipeline (StateDB, code-level state queries — no vector RAG). Use when asked to write or continue a novel, produce a specific chapter, compare chapter branches, or run the novel-engine generation pipeline. The novel project data (bible, planning, config) lives alongside this skill under src/novel_engine/.
---

# Novel-Engine Skill

Novel-Engine is an AI-powered pipeline and state machine designed for writing, refining, and validating full-length web novels. Based on the Prime-Agent底座, it utilizes a multi-agent assembly line pattern to generate robust chapter-by-chapter narratives with high consistency, quality control, and auto-rollback safety.

## Architecture & Features

1. **StateDB (Code-based Precision State Retrieval)**:
   - Uses localized SQLite database queries to fetch exact character attributes, realms, locations, and foreshadow status.
   - Bypasses traditional probabilistic RAG context drift, ensuring 100% accurate status awareness across millions of words.

2. **Durable Session Tree**:
   - Manages creative exploration branch points (similar to Git branch forks).
   - Allows automatic cascade rollback of world states and text version snapshots when review scores fall below quality thresholds or plot corrections are needed.

3. **Recursive Subagent Concurrency**:
   - Spawns isolated execution nodes (Chapter Director, World Simulator, Writer Agent, Reviewer Agent) dynamically for scene-specific generation.

4. **Incremental Patcher**:
   - Performs localized stitch-and-patch of scenes instead of regenerating entire chapters, saving tokens and preserving verified text blocks.

## Directory Structure

> 目录树于 2026-11-07 按实际结构订正。运行态（跑到哪、怎么续跑、有哪些待决项）以 `docs/HANDOFF.md` 为准。

```
packages/coding-agent/skills/novel-engine/
├── SKILL.md
├── README.md
├── pyproject.toml
├── .gitignore
├── docs/                      # 说明文档
│   ├── HANDOFF.md             # 交接入口：当前进度 / 下一步 / 硬约束（先读这个）
│   ├── runbook.md             # 旧运行手册（已过时，仅存档）
│   ├── superpowers/           # quality-backlog.md（决策与验收正本）等
│   ├── 使用说明指南.md
│   ├── 编写指南.md
│   ├── 效率优化方案.md
│   └── DEVELOPMENT_PLAN.md
├── scripts/                   # 控制脚本（Windows .bat / Unix start.sh）
│   ├── control/               # control.py + *.bat（封装 production_runner）
│   ├── check_static.py        # pyflakes 未定义名门禁
│   └── start.sh
└── src/
    └── novel_engine/          # 包根 = 数据根
        ├── __init__.py
        ├── agents/            # 智能体层
        │   ├── chapter_director.py    # Task card dispatcher agent
        │   ├── world_simulator.py     # Pre-chapter environment simulation
        │   ├── writer_agent.py        # Multi-scene content generator
        │   └── reviewer_agent.py      # Multi-dimension score audit agent
        ├── core/              # 核心支撑层
        │   ├── llm_client.py          # Mock/HTTPX LLM connection client
        │   ├── memory_manager.py      # 记忆与质量记忆管理
        │   ├── state_machine.py       # Assembly line transition model
        │   └── checkpoint.py          # Verification and disk backup system
        ├── engine/            # 底层库
        │   ├── db.py                  # StateDB (SQLite 精确状态检索)
        │   ├── session.py             # Durable Session Tree
        │   ├── patcher.py             # Incremental Patcher
        │   └── subagent.py            # 递归子智能体派生接口
        ├── pipeline/          # 流水线编排与入口
        │   ├── pipeline_orchestrator.py  # Main workflow compiler & assembler
        │   ├── production_runner.py     # 全量生产运行器
        │   ├── web_dashboard.py        # Web 可视化控制台
        │   └── init_state.py           # 世界状态初始化脚本
        ├── tests/             # 单测（test_*.py）+ domain_* 专项目录 + fixtures
        │   ├── mini_test_runner.py     # 10-chapter mock compiler test suite
        │   └── medium_test_runner.py   # 70-chapter sliding-window test suite
        ├── quality/           # 质量门与检测器（cross_scene_crisis_gate 等）
        ├── scripts/           # run_volume / generate_mid_outline / audit_mid_outline
        ├── tools/             # ab_evaluate / probe_ratelimit
        ├── bible/             # Style, world, and character bible documents
        ├── config/            # Quality thresholds & runtime cost config
        │   ├── planning/      # volumes.json / mid_outline_*.json / plot_graph
        │   ├── foreshadow/    # Foreshadowing trackers & registries
        │   ├── simulation/    # Simulation constraints & laws
        │   └── leak_terms/ naming_consistency/ synonym_map/
        ├── memory/            # Generated memory & dynamic world state
        ├── audit/             # Generated audit reports
        ├── chapters/          # novel / draft / draft/failed / outline / state
        ├── timeline/          # 时间线锚点
        └── runtime/           # State machine persistence & logs
```

## Running Tests

From the package root (`src/`), run the unit tests for the core library:
```bash
cd src
poetry run python -m unittest novel_engine.tests.test_novel_engine -v
```

To run the 10-chapter compilation workflow under simulation (Mock):
```bash
cd src
poetry run python -m novel_engine.tests.mini_test_runner
```

To run against the real API (SiliconFlow / Qwen), add `--real`:
```bash
cd src
poetry run python -m novel_engine.tests.mini_test_runner --real
```

## Agent API (Prime-Agent skill)

When loaded as a Prime-Agent Python skill, this package is pre-imported in the
persistent IPython kernel as `novel_engine`. Call its functions directly:

```python
# One-time init (seeds world state; pass reset=True to wipe + reseed)
await novel_engine.init_state()

# Generate and commit a single chapter (full pipeline: sim → direct → write → review → self-heal → commit)
result = await novel_engine.generate_chapter(1)
# -> {"chapter": 1, "success": True, "score": 82, "errors": []}

# Score an already-committed chapter with the independent review model
await novel_engine.review_chapter(1)
# -> {"chapter": 1, "score": 82, "verdict": "pass", "review": {...}}

# Re-run the self-healing / remediation loop for a chapter
await novel_engine.self_heal(1)

# Generate N candidate chapters and keep the best by review score
await novel_engine.branch_compare(1, variants=2)

# Idempotent finalize check
await novel_engine.commit(1)
# -> {"chapter": 1, "committed": True}
```

All functions accept an optional `project_root` (path to a novel project; defaults
to this skill directory) and `generate_chapter` / `self_heal` / `branch_compare`
accept `use_mock=True` to run the pipeline without any API calls (useful for
smoke tests). The standalone `production_runner.py` remains available for
unattended full-length runs.

### Phase 2 — RLM recursive subagents (Prime-Agent kernel)

When driven by the Prime-Agent agent loop, scene groups can be generated by
recursive subagents instead of the synchronous `ThreadPoolExecutor` fan-out.

At the start of a session, inject the kernel handles once:

```python
await novel_engine.set_kernel_handles(rlm=rlm, agent_message=agent_message)
```

Then generate a chapter with subagents (falls back to the standard pipeline
when `rlm` is not injected — so the standalone run is never affected):

```python
# The root agent spawns one subagent per scene group; each subagent calls:
await novel_engine.generate_scene_unit(chapter_num, scene_index, task_card, synopsis, scene_blueprint)
# and returns the scene text over agent_message. The parent assembles + commits.

result = await novel_engine.generate_chapter_with_subagents(1)
# -> {"chapter": 1, "success": True, "score": 84}
```

`generate_chapter_with_subagents` reuses the same world-sim → director →
synopsis → review → commit pipeline; only the scene-writing stage is delegated
to `rlm('sub-task')` subagents. Branch comparison (`branch_compare`) likewise
spawns candidate-generation subagents and keeps the best-scoring draft.
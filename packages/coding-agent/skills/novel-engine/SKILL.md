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

```
packages/coding-agent/skills/novel-engine/
├── SKILL.md
├── README.md
├── pyproject.toml
├── .gitignore
├── docs/                      # 说明文档
│   ├── 使用说明指南.md
│   ├── 编写指南.md
│   ├── 效率优化方案.md
│   └── DEVELOPMENT_PLAN.md
├── scripts/                   # 启动脚本（Windows .bat / Unix start.sh）
│   ├── generate.bat
│   ├── start_dashboard.bat
│   ├── status.bat
│   ├── stop.bat
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
        │   ├── gui_console.py          # 控制台 UI
        │   └── init_state.py           # 世界状态初始化脚本
        ├── tests/             # 单元测试与测试运行器
        │   ├── test_novel_engine.py    # 核心库单元测试
        │   ├── mini_test_runner.py     # 10-chapter mock compiler test suite
        │   └── medium_test_runner.py   # 70-chapter sliding-window test suite
        ├── bible/             # Style, world, and character bible documents
        ├── config/            # Quality thresholds & runtime cost config
        ├── foreshadow/        # Foreshadowing trackers & registries
        ├── planning/          # Volume/Plot graphs & full outline
        ├── simulation/        # Simulation constraints & laws
        ├── memory/            # Generated memory & dynamic world state
        ├── audit/             # Generated audit reports
        ├── chapters/          # Generated chapter outputs
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
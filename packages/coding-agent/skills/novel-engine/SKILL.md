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
├── pyproject.toml
└── src/
    └── novel_engine/
        ├── bible/                  # Style, world, and character bible documents
        ├── config/                 # Quality thresholds & runtime cost config
        ├── foreshadow/             # Foreshadowing trackers & registries
        ├── novel_engine/           # Core database, session, and patcher library
        │   ├── __init__.py
        │   ├── db.py
        │   ├── patcher.py
        │   ├── session.py
        │   ├── subagent.py
        │   └── test_novel_engine.py
        ├── planning/               # Volume/Plot graphs & outline planners
        ├── simulation/             # Simulation constraints & laws
        ├── chapter_director.py     # Task card dispatcher agent
        ├── checkpoint.py           # Verification and disk backup system
        ├── llm_client.py           # Configurable connection client supporting Mock/HTTPX
        ├── mini_test_runner.py     # 10-chapter mock compiler test suite
        ├── pipeline_orchestrator.py# Main workflow compiler & assembler
        ├── reviewer_agent.py       # Multi-dimension evaluation & score audit agent
        ├── state_machine.py        # Assembly line transition model
        ├── world_simulator.py      # Pre-chapter environment simulation model
        └── writer_agent.py         # Multi-scene content generator
```

## Running Tests

To run the unit tests for the core library:
```bash
pytest packages/coding-agent/skills/novel-engine/src/novel_engine/novel_engine/test_novel_engine.py
```

To run the 10-chapter compilation workflow under simulation:
```bash
cd packages/coding-agent/skills/novel-engine/src/novel_engine/ && python3 mini_test_runner.py
```

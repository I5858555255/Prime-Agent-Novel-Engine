# Novel-Engine（小说创作与编译引擎）📖🤖

`Novel-Engine` 是一款基于 **Prime-Agent** 底座构建、面向长篇网络小说创作的高性能 AI 流水线与状态机。它用代码级的精确状态检索替代传统概率性 RAG，通过持久化的分支会话管理、高度并发的子智能体分工，以及场景级自适应缝合修补，实现**全自动、高质量、具备自动回滚与自修复能力**的章节编译与长线剧情控制。

本引擎已被完整应用于长篇仙侠巨作 **《吸氧证道：阴阳逆碳，我以人道定仙天》** 的生成与迭代，表现出极高的剧情连贯性、人物设定一致性以及大纲执行深度。

> 仓库根目录的 `README.md` 介绍的是 Prime-Agent 主体；本文档专指 `packages/coding-agent/skills/novel-engine` 这一个**小说创作技能（skill）**。

---

## 🌟 一、核心设计理念与架构

### 1. StateDB（代码级精准状态检索）
传统小说生成依赖向量数据库检索（RAG），极易因长上下文产生“幻觉”与概率漂移，造成境界错乱、配角起死回生等逻辑车祸。
- **方案**：使用本地 SQLite（`engine/db.py`）做强类型字段查询，精确跟踪主角与每个配角的实时属性（境界、灵息、HP/SP、地理位置、持有道具、关系网等）。
- **效果**：在数百万字创作中，状态感知 100% 准确，且可被 `world_simulator` 与世界状态 JSON 双向校验。

### 2. Durable Session Tree（持久化会话树）
小说创作是非线性探索，一个糟糕桥段可能导致后续数十万字崩盘。
- **方案**：模拟 Git 的分支管理（`engine/session.py`），每次生成自动建立版本快照与校验哈希。
- **效果**：当遭遇“审核不通过”“剧情跑偏”“人设 OOC”等低分警报时，系统自动回撤到安全版本、剪枝失效探索并沿新方向重生成。

### 3. Recursive Subagent Concurrency（递归子智能体并发）
单模型难以胜任“统筹大纲 → 场景把控 → 细节描写 → 严苛评估”的多重重任。
- **方案**：将单次编写拆解为多智能体流水线；场景写入阶段既可用 `ThreadPoolExecutor` 扇出，也可在 Prime-Agent RLM 内核下派生子智能体（`agent_api.generate_chapter_with_subagents`）。
- **角色**：章节导演、世界模拟器、缩写体、执笔体、审核体、节奏顾问（详见第三节）。

### 4. Incremental Patcher（自适应增量补丁）
拒绝因局部小瑕疵就全量重写数千字（浪费 Token 且破坏语气连贯）。
- **方案**：`engine/patcher.py` 的定位式拼补（Stitch-and-Patch）算法。
- **效果**：Reviewer 发现局部问题时，精准框定瑕疵场景，仅对特定段落修改与局部缝合，极大节省成本并保留已验证文本块。

### 5. 多层容错（LLM 调用韧性）
三套相互正交的重试层保障无人值守长任务：
- **网络层重试**（`core/llm_client.py`）：HTTP 超时/断连的指数避退重试。
- **质量层重试**（`core/llm_provider.py`）：输出不合法/低质时按 `retry_temperatures` 换温度重采样。
- **模型层故障转移**（`core/llm_failover.py`）：主模型连续失败达到阈值后切换到备用模型。

---

## 📚 二、小说创作系统详述（核心）

这是本引擎的“灵魂”部分。所有小说创作都受一组**持久恒定的创作圣经（bible）**与**可编程的剧情约束**驱动，再由多智能体流水线逐章编译。

### 2.1 创作圣经（bible/，不可随意改动）
| 文件 | 作用 |
|------|------|
| `world_bible.md` | 世界地理、势力分布、力量体系（修炼/境界/灵息等量化设定） |
| `character_bible.md` | 核心角色人设、关系矩阵、成长弧光与禁忌 |
| `style_bible.md` | 叙事视角、文风偏好、章节结构铁律与情感基调 |
| `author_intent.md` | 分阶段主题、情绪曲线、各阶段严苛禁令 |
| `ending_bible.md` | 命运锚点、终局设定与关键伏笔回收计划 |

这些文件被 `chapter_director` 与 `writer_agent` 直接注入 prompt，是“人设/文风一致性”的源头约束。

### 2.2 多智能体创作流水线（agents/）
每一章都经过以下角色接力（对应状态机的 `PLANNING → WORLD_SIM → DIRECTING → SYNOPSIS → WRITE_SCENE → POLISH → REVIEW`）：

- **章节导演 `chapter_director.py`**
  解析 `config/planning/plot_graph.json` 与 `config/foreshadow/registry.json`，结合 bible，产出**任务卡（Task Card）**——含分场景蓝图（Scene Blueprints：地点、出场人物、目标、冲突、情绪）与**伏笔执行指令（foreshadow_actions）**。
- **世界模拟器 `world_simulator.py`**
  在落笔前预演本章对世界/人物状态的影响：模拟境界突破、位置迁移、关系变化；并强制校验 `config/simulation/constraints.json` 中的**境界锁定（realm_lock）**与**剧情锁定（plot_lock）**，锁定未到解锁章的角色行为。
- **缩写体（Synopsis Agent，内置于 `writer_agent.py`）**
  依据任务卡拟定场景剧情提纲，并把动态状态变化写入 pending 池。
- **正文执笔体 `writer_agent.py`**
  按任务卡 + 提纲分场景并发描写（默认 `ThreadPoolExecutor` 扇出；RLM 模式下改派子智能体）。严格携带并**执行所有 `foreshadow_actions`**，确保伏笔埋设。
- **节奏顾问 `pacing_advisor.py`**
  依据任务卡的情绪曲线，向每个场景注入**节奏硬性约束（pacing_constraints）**，抑制套路化与节奏平淡。
- **审核评估体 `reviewer_agent.py`**
  独立评审模型，按六维加权评分（见 2.3），输出分数、`verdict` 与可定位的问题段落。

### 2.3 六维评审与质量门禁
评分维度与权重定义在 `config/quality_thresholds.json`：

| 维度 | 权重 | 说明 |
|------|------|------|
| 剧情一致性 | 25 | 是否严格遵循 `plot_graph` 节点目标与伏笔计划 |
| 人物一致性 | 20 | 角色行为/语气/境界是否与 `world_state` 一致 |
| 伏笔执行 | 20 | `clue_plan` 的指令是否在缩写/正文中体现 |
| 文风符合度 | 15 | 是否符合 `style_bible.md` 的视角/语言/基调 |
| 节奏控制 | 10 | 场景切换、情绪曲线是否符合任务卡 |
| 创新亮点 | 10 | 是否有超出模板的生动细节或意外转折 |

**判定线（grading）**：`score ≥ 85` → `pass`；`60 ≤ score < 85` → `fix`；`score < 60` → `fail`。
**修复策略（fix_strategy）**：60–84 分仅局部修复被标记段落（保留其余）；低于 60 分全量回退到导演环节重来（最多 3 次）。

> 注意：生成侧与评审侧使用**不同模型**（`runtime_config.json` 中 `llm` vs `review_llm`），以保证评审独立性。

### 2.4 质量保障子系统（quality/）
- **`forbidden_scanner.py`**：依据 `config/forbidden.json` 扫描违禁词/敏感内容。
- **`continuity_auditor.py`**：人设与设定漂移审计（配合 StateDB 校验）。
- **`defects_store.py`**：记录缺陷、追踪修复闭环。

### 2.5 长线控制三件套
- **规划 `config/planning/`**：`volumes.json`（卷纲：起始章/主题/高潮）、`plot_graph.json`（剧情 DAG 依赖图，无环单向）。
- **伏笔 `config/foreshadow/registry.json`**：埋设点（plant）、暗示点（clue_plan）、回收点（resolve_chapter）；运行到对应区间时系统自动捞起并强制 Writer 执行。
- **仿真 `config/simulation/`**：`rules.json`（修炼速度/突破跨度/战力平衡量化规则）、`constraints.json`（角色境界锁定、剧情锁定）。

### 2.6 状态机生命周期
```
 [INIT]
   ▼
[PLANNING]  ── 结合 plot_graph 划定本章线索与目标
   ▼
[WORLD_SIM] ── 预估世界/角色/伏笔变更，锁定约束（realm/plot lock）
   ▼
[DIRECTING] ── 生成含 Scene Blueprints 的任务卡 + foreshadow_actions
   ▼
[SYNOPSIS] ── 编写提纲，提取动态状态变化到 pending 池
   ▼
[WRITE_SCENE] ── 递归/并发编写场景正文（执行所有伏笔指令）
   ▼
 [POLISH]   ── 文风、叙事张力、语句润色
   ▼
 [REVIEW]   ── 六维评审：
   ├── score ≥ 85 [PASS] ─► [COMMIT]（写文件+更新 StateDB+快照）─► [NEXT_CHAPTER]
   ├── 60 ≤ score < 85 [FIX] ─► 局部拼补后重审
   └── score < 60  [FAIL] ─► 回退到 DIRECTING 重来（≤3 次，耗尽转 [NEEDS_HUMAN]）
```

---

## 🗂️ 三、项目目录结构（当前实际布局）

```
packages/coding-agent/skills/novel-engine/
├── SKILL.md                      # 技能描述（Prime-Agent 加载规范）
├── README.md                     # 本文档
├── pyproject.toml                # Poetry 依赖
├── .gitignore                    # 已忽略 launch_prod.bat 等含密钥文件
├── docs/                         # 技能级说明文档
│   ├── 使用说明指南.md
│   ├── 编写指南.md
│   ├── 效率优化方案.md
│   ├── DEVELOPMENT_PLAN.md
│   └── runbook.md
├── scripts/
│   ├── start.sh                  # Unix 一键启动
│   └── control/                  # Windows 控制脚本 + control.py + USAGE.md
│       ├── start.bat / stop.bat / status.bat / tail.bat / clean.bat
│       ├── resume.bat / setkey.bat
└── src/
    └── novel_engine/             # 包根 = 数据根
        ├── __init__.py
        ├── agent_api.py          # Prime-Agent 内核 API（见第六节）
        ├── agents/
        │   ├── chapter_director.py   # 任务卡派发
        │   ├── world_simulator.py    # 世界/境界/伏笔预仿真
        │   ├── writer_agent.py       # 多场景并发正文生成
        │   ├── reviewer_agent.py     # 六维评分审计官
        │   └── pacing_advisor.py     # 节奏/情绪顾问
        ├── core/
        │   ├── llm_client.py         # LLM 通信（Mock/HTTPX + 网络重试）
        │   ├── llm_provider.py       # 结构化输出 Provider（质量重试 + 多温度）
        │   ├── llm_failover.py       # FailoverLLMClient（主→备切换）
        │   ├── memory_manager.py     # 记忆与质量记忆
        │   ├── state_machine.py      # 状态机总线
        │   └── checkpoint.py         # 版本快照/校验
        ├── engine/
        │   ├── db.py                 # StateDB（SQLite 精确状态检索）
        │   ├── session.py            # Durable Session Tree
        │   └── patcher.py            # Incremental Patcher
        ├── pipeline/
        │   ├── pipeline_orchestrator.py  # 总体调度 + 滑动窗口
        │   ├── production_runner.py      # 全量生产运行器（支持 3800 章）
        │   ├── init_state.py             # 世界状态初始化
        │   ├── reset_state.py            # 运行时重置（重跑时清空）
        │   └── web_dashboard.py         # Web 可视化控制台
        ├── quality/
        │   ├── forbidden_scanner.py
        │   ├── continuity_auditor.py
        │   └── defects_store.py
        ├── tests/
        │   ├── test_novel_engine.py  # 核心库单元测试
        │   ├── test_autonomy.py      # 自主运行测试
        │   ├── mini_test_runner.py   # 10 章编译测试
        │   ├── medium_test_runner.py # 70 章滑动窗口测试
        │   ├── slo_gate.py / aggregate_slo.py  # SLO 评分门禁
        ├── bible/                    # 创作圣经（2.1 节）
        │   ├── world_bible.md / character_bible.md / style_bible.md
        │   ├── author_intent.md / ending_bible.md
        ├── config/                   # 运行参数（已统一收纳）
        │   ├── runtime_config.json    # LLM 接线 + 质量/管道参数
        │   ├── cost_sandbox.json      # 预算与 Token 成本换算
        │   ├── forbidden.json         # 违禁词库
        │   ├── quality_thresholds.json# 六维权重与通过线
        │   ├── planning/              # 长线剧情规划
        │   │   ├── volumes.json
        │   │   └── plot_graph.json
        │   ├── foreshadow/            # 伏笔管理
        │   │   └── registry.json
        │   └── simulation/           # 仿真世界运行规则
        │       ├── rules.json
        │       └── constraints.json
        ├── docs/
        │   └── 吸氧证道_V2_1_完整大纲.md  # 完整大纲（按卷解析）
        ├── memory/                   # 记忆与动态世界状态（自动维护，勿手改）
        │   ├── world_state/  short_term/  long_term/  quality_memory.json
        ├── audit/                    # 审计报告（自动生成）
        ├── chapters/                 # 最终产物
        │   ├── novel/    synopsis/    outline/
        └── runtime/                  # 状态机持久化与日志
            ├── checkpoint.json  state_machine.json
            ├── recovery_policy.json  session_tree.json
```

> 注：早期文档中出现的 `planning/`、`foreshadow/`、`simulation/` 顶层目录与 `gui_console.py`、`engine/subagent.py` 已在结构整理中迁移/移除，请以本结构为准。

---

## ⚙️ 四、配置详解（config/）

### 4.1 LLM 接线（runtime_config.json）—— 当前生效方案
引擎遵循“**生成模型 ≠ 评审模型**”原则，确保评审独立性：

- **生成（Generation）** — `FailoverLLMClient`
  - 主：`llm` 段（provider=openai，model=`deepseek-ai/DeepSeek-V3.2`，api_base=`https://api.siliconflow.cn`，密钥取自环境变量 **`ZLEAP_MODEL_API_KEY`**）
  - 备：`fallback_llm` 段（同为 SiliconFlow，密钥 **`ZLEAP_MODEL_API_KEY`**）
- **评审（Review）** — `FailoverLLMClient`
  - 主：`review_llm` 段（model=`agnes-2.5-flash`，api_base=`https://apihub.agnes-ai.com`，密钥取自 **`AGNES_API_KEY`**）
  - 备：`fallback_llm` 段（ZLEAP 密钥）

即：**DeepSeek（SiliconFlow）负责正文创作，Agnes 负责独立评审**。密钥一律通过环境变量注入，绝不硬编码；`launch_prod.bat` 与 `scripts/control/setkey.bat` 负责设置，且 `launch_prod.bat` 已被 `.gitignore` 忽略以免泄露。

### 4.2 quality（runtime_config.json 内嵌 + quality_thresholds.json）
- 通过线：`pass_threshold=85`、`fix_threshold=60`、`publication_line=88`、`min_chapter_score=60`
- 节奏/创新下限：`min_pacing=7.5`、`min_innovation=7.0`、目标均分 `target_avg_score=88`
- 六维权重见 2.3 节（来自 `quality_thresholds.json`）

### 4.3 管道参数（pipeline 段）
`total_chapters=3800`、`sliding_window_size=50`、`recent_memory_window=30`、`max_review_retries=3`、`scene_per_chapter={min:3,max:5}`。

### 4.4 预算（cost_sandbox.json）
- 总预算 `total=500 USD`；`full_production_max=400`、`medium_test_max=50`、`mini_test_max=5`
- 单章估算 `per_chapter_estimate=0.08`（≈ 3800 章约 $304，控制在 $400 内）
- Token 计价：`input_per_1k=0.50`、`output_per_1k=1.00`（API 定价换算）
- 告警：`warning_pct=70`、`critical_pct=90`

### 4.5 约束与违禁
- `forbidden.json`：违禁词库（`quality/forbidden_scanner.py` 使用）
- `config/simulation/constraints.json`：角色境界锁定、剧情锁定

---

## 🚀 五、快速上手与运行指南

环境：Poetry 管理的 **Python 3.12**。引擎内置 **Mock 模式**，可零成本秒级验证整条流水线。

### 1. 安装依赖
```bash
cd packages/coding-agent/skills/novel-engine
poetry install
```

### 2. 单元测试（核心库）
```bash
cd src
poetry run python -m unittest novel_engine.tests.test_novel_engine -v
```

### 3. Mini 测试（10 章编译）
```bash
cd src
poetry run python -m novel_engine.tests.mini_test_runner          # Mock，1 秒跑完
poetry run python -m novel_engine.tests.mini_test_runner --real   # 真实 API
```

### 4. Medium 测试（70 章 + 滑动窗口）
每 50 章触发一次滑动窗口交叉审查，汇总套路重复/节奏平淡/伏笔搁置等问题。
```bash
cd src
poetry run python -m novel_engine.tests.medium_test_runner
```

---

## 🏭 六、全量生产运行（3800 章）

`pipeline/production_runner.py` 是无人值守的全量运行器。

**CLI：**
```bash
# 用法：python production_runner.py <章节数> [--real] [start_from] [resume_checkpoint]
python production_runner.py 3800 --real          # 从第 1 章完整重生成（自动 reset）
python production_runner.py 3800 --real 1 0      # 等价写法（resume=0 ⇒ 重置运行时）
python production_runner.py 3800 --real 1 120    # 从第 1 章起，但跳过已提交的 1..120（续跑）
```

**关键行为：**
- `resume_checkpoint=0`（默认）会调用 `reset_state.reset_runtime_state()`，**清空** `chapters/`、`audit/`、`memory/` 及 `runtime/*.json`，然后从第 1 章重新开始——即“完整重新生成”。
- `resume_checkpoint>0` 时跳过已落盘且三件套（novel/synopsis/outline）齐全的章节，用于**续跑/断点恢复**。
- 每 50 章触发滑动窗口审查，并刷新质量记忆。

**后台启动（Windows，举例）：**
```bat
@echo off
set PYTHONPATH=.../src
set ZLEAP_MODEL_API_KEY=****      :: 仅经环境变量注入
set AGNES_API_KEY=****
cd .../src/novel_engine/pipeline
python production_runner.py 3800 --real >> production_console.log 2>&1
```
该进程为**脱离终端**运行，终端关闭/会话结束也不影响；当前运行 PID 可用
`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ?{$_.CommandLine -match 'production_runner'}` 查看。

**监控：**
```powershell
# 最新进度
Get-Content ".../src/novel_engine/runtime/logs/production.log" -Tail 15 -Encoding utf8
# 已生成章节数
(Get-ChildItem ".../src/novel_engine/chapters/novel").Count
```
**停止：** `Stop-Process -Id <PID>`。**恢复：** 以上述 `resume_checkpoint=N` 方式重跑。

---

## 🧩 七、作为 Prime-Agent 技能运行（agent_api）

加载为 Prime-Agent Python 技能后，包在持久 IPython 内核中预导入为 `novel_engine`，可直接调用：

```python
# 一次性初始化（seed 世界状态；reset=True 清空并重 seed）
await novel_engine.init_state()

# 生成并提交单章（完整流水线：sim→direct→write→review→self-heal→commit）
result = await novel_engine.generate_chapter(1)
# -> {"chapter": 1, "success": True, "score": 82, "errors": []}

# 用独立评审模型复评已提交章节
await novel_engine.review_chapter(1)
# -> {"chapter": 1, "score": 82, "verdict": "pass", "review": {...}}

await novel_engine.self_heal(1)        # 重跑自愈/修复循环
await novel_engine.branch_compare(1, variants=2)  # 生成 N 候选并保留最高分
await novel_engine.commit(1)           # 幂等最终化
```

所有函数接受可选 `project_root`（默认本技能目录）；`generate_chapter/self_heal/branch_compare` 支持 `use_mock=True` 做无 API 的冒烟测试。

### Phase 2 — RLM 递归子智能体（Prime-Agent 内核）
由 Prime-Agent 智能体循环驱动时，场景组可交由递归子智能体生成，而非同步 `ThreadPoolExecutor` 扇出：

```python
# 会话开始注入内核句柄一次
await novel_engine.set_kernel_handles(rlm=rlm, agent_message=agent_message)

# 每章：父智能体为每个场景组派一个子智能体，子智能体回调：
await novel_engine.generate_scene_unit(chapter_num, scene_index, task_card, synopsis, scene_blueprint)
# 父智能体组装并 commit
result = await novel_engine.generate_chapter_with_subagents(1)
# -> {"chapter": 1, "success": True, "score": 84}
```
（未注入 `rlm` 时自动退化到标准流水线，独立运行不受影响。）

---

## 🛡️ 八、自适应故障恢复与异常管理

引擎内置生产级故障恢复，未处理异常被拦截在流水线内，由 `runtime/recovery_policy.json` 全自动分流：

- **`json_parse_error`**：自动微调 prompt 重试（≤3 次），耗尽转半自动修正。
- **`api_disconnect`**：指数避退等待（`wait_and_retry`），保障无人值守继续。
- **`context_overflow`**：自适应收缩滑动窗口。
- **`world_state_conflict`**：读取 `checkpoint.json` 做 Git 式快照回滚，并标记 `NEEDS_HUMAN` 暂停。

---

## 🖥️ 九、Windows 控制脚本（scripts/control/）

| 脚本 | 功能 |
|------|------|
| `start.bat` | 启动生成（亦可接 `real` / `production` 参数） |
| `stop.bat` | 停止运行 |
| `status.bat` | 查看状态 / 章节列表 |
| `tail.bat` | 实时跟踪 `production.log` |
| `clean.bat` | 清理运行时数据 |
| `resume.bat` | 从断点续跑 |
| `setkey.bat` | 设置 API Key 环境变量 |

详见 `scripts/control/USAGE.md`。

---

## ✍️ 十、编写与扩展指南

向《吸氧证道》注入新剧情或定制世界观时，请遵照 `docs/编写指南.md` 的规范：

1. **世界观增加**：更新 `bible/world_bible.md`，保持高密大纲。
2. **新增大纲线索**：按 DAG 依赖顺序向 `config/planning/plot_graph.json` 追加无环单向节点。
3. **新增伏笔**：在 `config/foreshadow/registry.json` 配置，定义暗示点（`clue_plan`）与回收点（`resolve_chapter`）；运行到对应区间时系统自动捞起并强制 Writer 埋设/回收。
4. **仿真规则/锁定**：调整 `config/simulation/rules.json` 与 `constraints.json`（如角色境界解锁章）。
5. **文风/人设修正**：改 `bible/style_bible.md`、`character_bible.md`，并视情况触发对应章节的 `self_heal` 局部修复。

---

## 💰 十一、成本与预算

- 预算来源 `config/cost_sandbox.json`：全量生产上限 **$400**，总池 **$500**。
- 单章估算 **$0.08** → 3800 章约 **$304**（在预算内）。
- 成本由 `cost_tracker` 按真实 input/output token 实时累计；达 `warning_pct=70%` / `critical_pct=90%` 告警。
- 滑动窗口审查、导演、缩写、执笔、评审各自有独立成本估算项，便于定位开销。

---

## ⚠️ 十二、已知约束与注意事项

- **密钥安全**：API Key 仅经环境变量（`ZLEAP_MODEL_API_KEY` / `AGNES_API_KEY`）注入；`launch_prod.bat` 含密钥且已被 `.gitignore` 忽略，**切勿提交**。
- **增量语义**：单次运行内是增量的（只向后写、不覆盖已提交章节）；要“完整重新生成”，须以 `resume_checkpoint=0` 启动（自动 reset）或先 `clean`。
- **运行耗时**：3800 章为长周期任务（按当前节奏约需多日），请以后台进程方式运行并定期监控 `production.log`。
- **Mock 优先**：改动流水线/配置后，先用 `mini_test_runner`（Mock）验证，再上真实 API，避免无谓开销。
- **记忆目录勿手改**：`memory/`、`runtime/`、`audit/`、`chapters/` 由引擎自动维护。

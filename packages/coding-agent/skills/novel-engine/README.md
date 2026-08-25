# Novel-Engine (小说创作与编译引擎) 📖🤖

`Novel-Engine` 是一款基于 **Prime-Agent** 底座构建、面向长篇网络小说创作的高性能 AI 流水线与状态机。该引擎打破了传统概率性 RAG 的局限性，通过代码级的精确状态检索、持久化的分支会话管理、高度并发的子智能体分工，以及场景级自适应缝合修补，实现全自动、高质量、具备自动回滚与自修复能力的章节编译与长线控制。

本引擎目前已被完整应用于长篇仙侠巨作《吸氧证道：阴阳逆碳，我以人道定仙天》的生成与迭代中，表现出极高的话题连贯性、人物设定一致性以及大纲执行深度。

---

## 🌟 核心设计理念与架构

### 1. StateDB (代码级精准状态检索)
传统的小说生成通常依赖于向量数据库检索（RAG），极易由于长上下文导致的“幻觉”和概率性漂移，造成境界错乱、配角起死回生等逻辑车祸。
- **解决方案**：使用本地轻量级 SQLite 数据库（或底层 JSON）进行强类型字段查询。
- **效果**：精确跟踪主角和每个配角的实时属性（境界、灵息、HP/SP、地理位置、持有道具等），确保在数百万字的创作中，状态感知 100% 准确。

### 2. Durable Session Tree (持久化会话树)
小说创作是典型的非线性探索。一个糟糕的桥段可能导致后续数十万字崩盘。
- **解决方案**：模拟 Git 的分支管理，引入**持久化会话树**。
- **效果**：系统在生成新章节时会自动建立版本快照和校验哈希。当遭遇“审核不通过”、“剧情跑偏”或“人设OOC”等低分警报时，系统将自动回撤到安全版本，剪枝掉失效探索并沿新方向重新生成。

### 3. Recursive Subagent Concurrency (递归子智能体并发)
单大语言模型难以胜任“统筹大纲-场景把控-细节描写-严苛评估”的多重重任。
- **解决方案**：将单次编写任务拆解为多智能体流水线。
- **角色分工**：
  - **章节导演 (Chapter Director)**：解析全局大纲，结合伏笔计划生成精准的任务卡（Task Card）。
  - **世界模拟器 (World Simulator)**：预先模拟当前章节对世界和人物带来的数值和状态影响。
  - **大纲缩写体 (Synopsis Agent)**：拟定场景剧情提纲、状态跃迁。
  - **正文执笔体 (Writer Agent)**：按任务卡和提纲分场景精心描写。
  - **审核评估体 (Reviewer Agent)**：从文风、人设、伏笔、一致性等多个维度严苛评分。

### 4. Incremental Patcher (自适应增量补丁)
拒绝因为局部小逻辑瑕疵就全量重写数千字，造成不必要的 Token 浪费和语气不连贯。
- **解决方案**：使用**定位式拼补（Stitch-and-Patch）**算法。
- **效果**：Reviewer 发现局部描写问题时，会精准框定瑕疵场景，仅对特定段落进行修改和局部缝合，不仅极大节省了 API 成本，同时也最大程度保留了优秀的已生成文本块。

---

## 🛠️ 项目目录结构

`Novel-Engine` 采用了极其严谨的技能分包（Skill Package）设计，整体结构如下：

```
packages/coding-agent/skills/novel-engine/
├── SKILL.md                         # 技能描述规范
├── pyproject.toml                   # Poetry 依赖管理
├── README.md                        # 本文档（专业、易懂的全面手册）
├── docs/                            # 说明文档
│   ├── 使用说明指南.md              # 完整使用手册
│   ├── 编写指南.md                  # 人工输入文件编写规范
│   ├── 效率优化方案.md              # 架构优化方案
│   └── DEVELOPMENT_PLAN.md          # 开发任务计划（T1-T10）
├── scripts/                         # 启动脚本
│   ├── generate.bat                 # 生成章节（Mock/真实/生产）
│   ├── start_dashboard.bat          # 启动 Web 控制台
│   ├── status.bat                   # 查看状态 / 章节列表 / 清理
│   ├── stop.bat                     # 停止服务
│   └── start.sh                     # Unix 一键启动脚本
└── src/
    └── novel_engine/                # 包根 = 数据根
        ├── __init__.py
        ├── agents/                  # 智能体层
        │   ├── chapter_director.py  # 任务卡派发器
        │   ├── world_simulator.py   # 物理规则仿真环境
        │   ├── writer_agent.py      # 正文与提纲编写器
        │   └── reviewer_agent.py    # 智能体评分审计官
        ├── core/                    # 核心支撑层
        │   ├── llm_client.py        # LLM 通信层（Mock/HTTPX）
        │   ├── memory_manager.py    # 记忆与质量记忆管理
        │   ├── state_machine.py     # 状态切换总线
        │   └── checkpoint.py        # 版本备份系统
        ├── engine/                  # 底层库
        │   ├── db.py                # StateDB 查询机制
        │   ├── session.py           # 分支树会话管理器
        │   ├── patcher.py           # 场景增量缝合补丁逻辑
        │   └── subagent.py          # 递归子智能体派生接口
        ├── pipeline/                # 流水线编排与入口
        │   ├── pipeline_orchestrator.py # 流水线总体调度与滑动窗口协调
        │   ├── production_runner.py # 全量生产运行器
        │   ├── web_dashboard.py     # Web 可视化控制台
        │   ├── gui_console.py       # 控制台 UI
        │   └── init_state.py        # 世界状态初始化脚本
        ├── tests/                   # 测试
        │   ├── test_novel_engine.py # 核心库单元测试集
        │   ├── mini_test_runner.py  # 10章迷你编译器测试集
        │   └── medium_test_runner.py# 70章带滑动窗口的长线测试集
        ├── bible/                   # 创作圣经（持久恒定的终极设定）
        │   ├── world_bible.md       # 世界地理、势力分布与力量体系
        │   ├── character_bible.md   # 核心角色人设、关系矩阵、成长弧光与禁忌
        │   ├── style_bible.md       # 叙事视角、文风偏好与章节结构铁律
        │   ├── author_intent.md     # 分阶段主题、情绪曲线与各阶段严苛禁令
        │   └── ending_bible.md      # 命运锚点、终局设定与关键伏笔回收计划
        ├── planning/                # 长线剧情规划
        │   ├── volumes.json         # 卷纲定义（起始章、主题、高潮设定）
        │   ├── plot_graph.json      # 剧情 DAG 依赖图
        │   └── 吸氧证道_V2_1_完整大纲.md # 完整大纲（按卷解析）
        ├── simulation/              # 仿真世界运行规则（常态配置，非必改）
        │   ├── rules.json           # 修炼速度、突破跨度、战力平衡量化规则
        │   └── constraints.json     # 角色境界锁定、剧情锁定
        ├── foreshadow/              # 伏笔管理系统
        │   └── registry.json        # 伏笔注册表（埋设点、暗示点、回收点）
        ├── config/                  # 运行参数与预算控制
        │   ├── quality_thresholds.json # 多维度评分通过线与修复行为判定阈值
        │   ├── runtime_config.json  # LLM API 密钥与并发参数
        │   └── cost_sandbox.json    # 模拟预算与 Token 转换对照表
        ├── memory/                  # 记忆数据与动态世界状态（自动维护，请勿手动编辑）
        │   ├── world_state/         # 角色实时世界状态属性
        │   ├── short_term/          # 局部滑动窗口上下文摘要
        │   ├── long_term/           # 章节长线历史索引
        │   └── quality_memory.json  # 滑动窗口审查反馈
        ├── audit/                   # 产出与审计报告目录（自动生成）
        ├── chapters/                # 最终生成产物
        │   ├── novel/               # 章节正文文本 (.txt)
        │   ├── synopsis/            # 章节剧情大纲 (.txt)
        │   └── outline/             # 章节任务卡详情 (.json)
        └── runtime/                 # 状态机持久化和日志
            ├── checkpoint.json      # 安全版本快照
            ├── state_machine.json   # 运行时状态控制
            └── recovery_policy.json # 全自动故障恢复策略
```

---

## ⚙️ 核心工作流与状态转移

Novel-Engine 通过状态机强约束整个章节生命周期，各阶段严格对应如下状态转移：

```
 [INIT]
   │
   ▼
[PLANNING] ──► 结合全局 plot_graph 划定当前章节的线索和目标
   │
   ▼
[WORLD_SIM] ──► 预估该章世界、角色境界、伏笔状态带来的变更并锁定约束
   │
   ▼
[DIRECTING] ──► 生成包含具体场景设计（Scene Blueprints）的《任务卡》
   │
   ▼
[SYNOPSIS] ──► 编写剧情提纲，提取动态状态变化到 pending 池
   │
   ▼
[WRITE_SCENE] ──► 递归并发编写具体场景正文
   │
   ▼
 [POLISH] ──► 文风、叙事张力与语句润色
   │
   ▼
 [REVIEW] ──► 审核评估：
   ├── 分数 >= 85 [PASS] ──► [COMMIT] (写入最终文件、更新 StateDB 并持久化快照) ──► [NEXT_CHAPTER]
   ├── 85 > 分数 >= 60 [FAIL] ──► [FIX] (进入自适应局部拼补流程，重审)
   └── 分数 < 60 [FAIL] ──► [PLANNING] (全量重试/版本回滚，最多 3 次，耗尽则转 [NEEDS_HUMAN])
```

---

## 🚀 快速上手与运行指南

本引擎在 **Poetry** 管理的 Python 3.12 环境下运行良好。由于生成小说需要进行密集的模型调用，我们配备了完整的 **Mock 模式**，可以在本地进行秒级的大规模测试。

### 1. 安装依赖

进入小说引擎技能包目录并执行 Poetry 安装：
```bash
cd packages/coding-agent/skills/novel-engine
poetry install
```

### 2. 运行本地单元测试

对核心依赖（StateDB、会话管理、智能体生成和增量补丁）运行单元测试：
```bash
cd src
poetry run python -m unittest novel_engine.tests.test_novel_engine -v
```

### 3. 运行 10 章节编译测试 (Mini Test)

`tests/mini_test_runner.py` 是引擎自带的端到端编译和拼装管道校验器，支持在模拟（Mock）或真实 API 条件下运行 10 章节流水线生成，以检验系统的自洽性、状态维护和异常处理能力。

**Mock 模式快速运行（不消耗 API Key、无网络调用、1秒内跑完）**：
```bash
cd src
poetry run python -m novel_engine.tests.mini_test_runner
```

**实机测试模式（连接真实 LLM 服务，进行实境创作）**：
```bash
cd src
poetry run python -m novel_engine.tests.mini_test_runner --real
```

### 4. 运行 70 章节长线多窗测试 (Medium Test)

`tests/medium_test_runner.py` 主要用来对长篇创作中容易发生的“套路重复”、“节奏平淡”、“伏笔搁置”等长线结构问题进行**滑动窗口式交叉审查（Sliding Window Review）**，每 50 章节自动汇总一次问题，并产生动态优化建议。
```bash
cd src
poetry run python -m novel_engine.tests.medium_test_runner
```

---

## 🛠️ 自适应故障恢复与异常管理

引擎内置了生产级故障恢复模型，任何未处理的异常都会被拦截在流水线中。系统通过配置 `runtime/recovery_policy.json` 进行全自动分流：

- **`json_parse_error` (JSON 解析异常)**：自动对当前大模型 prompt 进行重试微调（最多 3 次），耗尽后退化为半自动手动修正。
- **`api_disconnect` (网络波动中断)**：开启自动指数避退等待（`wait_and_retry`），保障长任务在无人值守时安全继续。
- **`context_overflow` (上下文溢出)**：自适应检测并动态临时收缩滑动窗口。
- **`world_state_conflict` (状态冲突/数据损坏)**：读取 `runtime/checkpoint.json` 对当前章节进行 Git 式的快照回滚，并标记 `NEEDS_HUMAN` 暂停等待。

---

---

## 🖥️ Windows 启动脚本

项目 `scripts/` 目录提供以下批处理脚本，方便 Windows 用户使用：

| 脚本 | 功能 |
|------|------|
| `scripts/generate.bat` | 运行章节生成（Mock 或真实 API） |
| `scripts/start_dashboard.bat` | 启动 Web 可视化控制台 |
| `scripts/status.bat` | 查看当前生成状态和章节列表 |
| `scripts/stop.bat` | 停止运行的服务 |

### 快速使用

```cmd
:: 双击运行或在命令行中执行
scripts\generate.bat              :: 运行 10 章 Mock 测试
scripts\generate.bat real         :: 运行 10 章真实 API 测试
scripts\generate.bat production   :: 运行全量生产（3800章）
scripts\start_dashboard.bat       :: 启动 Web 控制台
scripts\status.bat                :: 查看当前状态
scripts\status.bat chapters       :: 查看已生成章节
scripts\status.bat clean          :: 清理运行时数据
```

---

## 📝 编写与扩展指南


当您准备对《吸氧证道：阴阳逆碳，我以人道定仙天》注入新的剧情或定制不同的世界观设定时，请遵照 **`docs/编写指南.md`** 的严苛规范编辑：
1. **世界观增加**：直接更新 `bible/world_bible.md`，并在 2000 字符内保持其高密度大纲。
2. **新增大纲线索**：按 DAG 依赖顺序，向 `planning/plot_graph.json` 追加无环单向图节点。
3. **新增伏笔**：在 `foreshadow/registry.json` 中配置伏笔，定义好暗示点（`clue_plan`）以及回收点（`resolve_chapter`），流式系统在运行到对应区间时会自动将其捞起，并强制要求 Writer Agent 埋设或收回。

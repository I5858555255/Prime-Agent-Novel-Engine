<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9cb3-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
  Prime-Agent-Novel-Engine：基于 Prime Agent 的自主长篇小说创作引擎
</h3>

<p align="center">
  <a href="packages/coding-agent/skills/novel-engine/README.md">Novel-Engine 详细文档</a> &bull;
  <a href="packages/coding-agent/docs/index.md">Prime Agent 文档</a> &bull;
  <a href="https://www.primeintellect.ai/blog/rlm">RLM</a>
</p>

---

## 这是什么

**Prime-Agent-Novel-Engine** 是 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 的一个**定向衍生版（fork）**，在保留 Prime Agent 自主智能体底座的基础上，额外内置了 **`novel-engine` 技能**——一套面向长篇网络小说全自动创作的 AI 流水线与状态机。

- **底座**：Prime Agent 提供持久化 RLM 内核、递归子智能体、Continual Harness 与长任务续航能力。
- **小说创作层**：`packages/coding-agent/skills/novel-engine` 把上述能力落地为「世界状态精确检索 → 多智能体分工写章 → 独立模型评审 → 自动回滚/自修复」的可控小说编译管道。

目前该引擎已被完整应用于长篇仙侠巨作 **《吸氧证道：阴阳逆碳，我以人道定仙天》** 的生成与迭代。

> 本文档覆盖 Prime Agent 原始 README 的核心内容，并重点说明**小说创作（novel‑engine）**部分。技能内部的完整手册见 [`packages/coding-agent/skills/novel-engine/README.md`](packages/coding-agent/skills/novel-engine/README.md)。

---

## Prime Agent 底座

Prime Agent 是一个面向通用与长周期任务的自主编程/研究智能体，围绕两个核心抽象构建：

- **递归语言模型（RLM, Recursive Language Model）**：把上下文视为变量（*prompt‑as‑a‑variable*），把工具（如递归子智能体）视为函数调用（*programmatic tool / sub‑agent calling*），运行在持久化 REPL 中。
- **Continual Harness**：把补充提示、记忆、技能描述、可复用子智能体规格作为**持久化状态**存储，Prime Agent 可通过小而经证据支撑的更新来持续自我改进（默认限于本次会话）。

Prime Agent 结合持久化 Python 控制环境与持久化 Harness 状态，使有用的工作上下文与可复用操作模式能超越单次聊天窗口而长期存在。

核心特性：

- **一切皆可编程**：持久化 IPython 是内置的模型工具；文件操作、shell 命令、工具调用、子智能体、上下文管理都通过代码完成。
- **内置子智能体**：`rlm(...)` 可派生真实子智能体执行并行或后台工作，并以编程方式返回结果。
- **Harnass 可自我改进**：`/refine` 复盘当前轨迹，对补充 Harness 状态做小而经证据支撑的更新（绝不改写不可变的基础系统提示，且记录快照支持回滚）。
- **技能即可执行包**：技能是可 import 的 Python 包；内置技能创建器可把重复工作流沉淀为项目/个人技能。
- **会话后台运行**：daemon 托管的智能体在终端断开后继续运行，可稍后重新接管。
- **智能体间直接通信**：运行中的智能体可互相交换消息、编排彼此，无需都经用户中转。
- **长任务持续推进**：自动压缩、持久目标、心跳、调度、自主模式与保留子智能体，跨多轮与终端会话保留进度。

### 快速开始（Prime Agent 部分）

> 本 fork 的「小说创作」能力通过 `novel-engine` 技能使用，详见下文「小说创作能力」。以下为 Prime Agent 本身的安装方式。

在 macOS / Linux 安装最新稳定版：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

安装器会下载带版本号的发布包、校验 SHA‑256、安装 `prime-agent` 命令，并可准备 Agent 使用的 IPython 运行时。

从你希望它工作的仓库或目录启动：

```bash
cd /path/to/project
prime-agent
```

首次启动运行 `/login` 选择订阅或 API‑key 提供方。Prime Agent 在当前目录工作，可执行命令、修改文件。建议使用可丢弃的克隆、干净工作树或可被检查/恢复的 checkpoint。

> [!WARNING]
> Prime Agent 以你的用户权限执行模型生成的 Python 与项目命令。其 worker/kernel 进程改善了生命周期隔离与恢复，但**不是**安全沙箱。请审查变更，仅使用受信任的仓库、指令、技能与扩展；运行不可信代码或指令请在外部沙箱或受限环境中进行。

常用命令：

```bash
prime-agent agents                   # 浏览运行/空闲/已保存会话
prime-agent attach <agent>           # 重新接管运行中的会话
prime-agent --resume <path|id>       # 恢复已保存会话
prime-agent status                   # 查看后台服务状态
prime-agent doctor [--fix]           # 检查或修复后台服务
prime-agent update [--force]         # 更新 Prime Agent
prime-agent shutdown [--force]       # 停止所有智能体、worker 与后台服务
```

### 为长任务而设计

Prime Agent 为研究类评估等长任务而设计，TUI 与自主运行模式均提供以下能力：

- **Continual Harness**：`/refine` 可把聚焦、可审阅的经验沉淀为补充提示、记忆、可复用技能描述或子智能体规格，并记录改进历史（不替代打包与评审新的可执行技能）。
- **智能体直连通信**：运行中的智能体与保留子智能体可互相发现、交换消息、引导活跃工作。
- **Daemon 托管的连续性**：活跃会话、IPython 状态、调度与子智能体在终端脱离后继续运行，可稍后重新接管。
- **心跳与调度**：`/heartbeat`、`rlm_heartbeat`、`prime-agent schedule` 可周期性或定时重新进入会话。
- **持久目标**：`/goal` 让目标及其进度跨多轮保持，直到完成、暂停或清除。
- **有界自主模式**：`/autonomous` 在配置的轮次、token、时间预算内持续运行，可运行用户自定义质量门禁（通过门禁只验证该门禁所验证的内容；触达上限不等于任务成功）。

---

## 📚 小说创作能力（novel-engine，核心）

> 完整手册见 [`packages/coding-agent/skills/novel-engine/README.md`](packages/coding-agent/skills/novel-engine/README.md)。本节为项目级总览。

`novel-engine` 是一款基于 Prime‑Agent 底座、面向长篇网络小说的高性能 AI 流水线与状态机。它用**代码级精确状态检索**替代传统概率性 RAG，通过持久化分支会话、并发子智能体分工与场景级自适应缝合修补，实现全自动、高质量、可自动回滚与自修复的章节编译与长线控制。

### 核心设计理念

1. **StateDB（代码级精准状态检索）**：本地 SQLite（`engine/db.py`）强类型查询，精确跟踪主角与配角的实时属性（境界、灵息、HP/SP、位置、道具、关系网），数百万字中状态感知 100% 准确，规避 RAG 漂移导致的「境界错乱/配角复活」等逻辑车祸。
2. **Durable Session Tree（持久化会话树）**：模拟 Git 分支（`engine/session.py`），每次生成建立版本快照与校验哈希；评审低分/跑偏时自动回撤安全版本并沿新方向重生成。
3. **Recursive Subagent Concurrency（递归子智能体并发）**：把单章拆为多智能体流水线；场景写入既可 `ThreadPoolExecutor` 扇出，也可在 Prime‑Agent RLM 内核下派生子智能体（`agent_api.generate_chapter_with_subagents`）。
4. **Incremental Patcher（自适应增量补丁）**：`engine/patcher.py` 仅对问题段落做定位式拼补（Stitch‑and‑Patch），节省 Token 并保留已验证文本。
5. **多层 LLM 容错**：网络层重试（`core/llm_client.py`）+ 质量层换温度重试（`core/llm_provider.py`）+ 模型层故障转移（`core/llm_failover.py`）三套正交重试，保障无人值守长任务。

### 多智能体创作流水线（agents/）

每一章经过：`PLANNING → WORLD_SIM → DIRECTING → SYNOPSIS → WRITE_SCENE → POLISH → REVIEW` 的状态机接力：

- **章节导演 `chapter_director.py`**：解析 `config/planning/plot_graph.json` 与 `config/foreshadow/registry.json`，结合 bible，产出含分场景蓝图（Scene Blueprints）与**伏笔执行指令（foreshadow_actions）**的任务卡。
- **世界模拟器 `world_simulator.py`**：落笔前预演本章对世界/人物状态的影响，模拟境界突破、位置迁移、关系变化，并强制校验 `config/simulation/constraints.json` 中的**境界锁定 / 剧情锁定**。
- **缩写体 / 执笔体 `writer_agent.py`**：按任务卡分场景并发描写，严格执行所有 `foreshadow_actions` 保证伏笔埋设；`pacing_advisor.py` 注入节奏硬性约束抑制套路化。
- **审核评估体 `reviewer_agent.py`**：独立评审模型，按六维加权评分（见下），输出分数、`verdict` 与可定位问题段落。

### 六维评审与质量门禁（`config/quality_thresholds.json`）

| 维度 | 权重 | 说明 |
|------|------|------|
| 剧情一致性 | 25 | 是否严格遵循 `plot_graph` 节点目标与伏笔计划 |
| 人物一致性 | 20 | 角色行为/语气/境界是否与 `world_state` 一致 |
| 伏笔执行 | 20 | `clue_plan` 指令是否在缩写/正文中体现 |
| 文风符合度 | 15 | 是否符合 `style_bible.md` 的视角/语言/基调 |
| 节奏控制 | 10 | 场景切换、情绪曲线是否符合任务卡 |
| 创新亮点 | 10 | 是否有超出模板的生动细节或意外转折 |

判定：`score ≥ 85` → `pass`（提交）；`60 ≤ score < 85` → `fix`（局部拼补后重审）；`score < 60` → `fail`（回退到导演环节重来，最多 3 次）。

### 模型接线（当前生效方案）

原则：**生成模型 ≠ 评审模型**，保证评审独立性。

- **生成**：`FailoverLLMClient`，主=`llm` 段（DeepSeek `deepseek-ai/DeepSeek-V3.2` @ `https://api.siliconflow.cn`，密钥环境变量 **`ZLEAP_MODEL_API_KEY`**），备=`fallback_llm`（同 SiliconFlow）。
- **评审**：`FailoverLLMClient`，主=`review_llm` 段（`agnes-2.5-flash` @ `https://apihub.agnes-ai.com`，密钥环境变量 **`AGNES_API_KEY`**），备=`fallback_llm`。

> 即：**DeepSeek（SiliconFlow）负责正文创作，Agnes 负责独立评审**。密钥一律经环境变量注入，绝不硬编码（仓库 `.gitignore` 已忽略含密钥的 `launch_prod.bat`）。

### 创作圣经与长线控制

- **创作圣经 `bible/`**：`world_bible.md`（世界/力量体系）、`character_bible.md`（人设/关系/弧光）、`style_bible.md`（文风铁律）、`author_intent.md`（分阶段主题/情绪曲线/禁令）、`ending_bible.md`（终局与伏笔回收）。被直接注入 prompt，是「人设/文风一致性」源头约束。
- **规划 `config/planning/`**：`volumes.json`（卷纲）、`plot_graph.json`（剧情 DAG，无环单向）。
- **伏笔 `config/foreshadow/registry.json`**：埋设点、暗示点（`clue_plan`）、回收点（`resolve_chapter`）；运行到对应区间自动捞起并强制 Writer 执行。
- **仿真 `config/simulation/`**：`rules.json`（修炼/突破/战力量化）、`constraints.json`（锁定约束）。
- **质量子系统 `quality/`**：`forbidden_scanner.py`（违禁词）、`continuity_auditor.py`（连贯性审计）、`defects_store.py`（缺陷闭环）。

### 如何运行小说创作

环境：Poetry 管理的 Python 3.12（技能内 `poetry install`）。内置 **Mock 模式**可零成本秒级验证。

```bash
cd packages/coding-agent/skills/novel-engine/src
# 10 章 Mock 编译测试（1 秒跑完）
poetry run python -m novel_engine.tests.mini_test_runner
# 10 章真实 API 测试
poetry run python -m novel_engine.tests.mini_test_runner --real
# 70 章滑动窗口长线测试
poetry run python -m novel_engine.tests.medium_test_runner
```

**全量生产（3800 章）：**

```bash
# resume_checkpoint=0 ⇒ 自动 reset 运行时，从第 1 章完整重生成
python production_runner.py 3800 --real
# 断点续跑：跳过已提交的 1..N
python production_runner.py 3800 --real 1 120
```

进程脱离终端运行，终端关闭不影响；监控 `src/novel_engine/runtime/logs/production.log` 与 `chapters/novel` 目录即可。

**作为 Prime‑Agent 技能调用（`agent_api.py`）：**

```python
await novel_engine.init_state()                 # 初始化世界状态（reset=True 清空重 seed）
result = await novel_engine.generate_chapter(1) # 完整流水线生成并提交
await novel_engine.review_chapter(1)            # 独立评审模型复评
await novel_engine.self_heal(1)                 # 自愈/修复循环
# RLM 模式下让子智能体分场景写作
await novel_engine.set_kernel_handles(rlm=rlm, agent_message=agent_message)
await novel_engine.generate_chapter_with_subagents(1)
```

### 成本与预算（`config/cost_sandbox.json`）

全量生产上限 **$400**，总池 **$500**；单章估算 **$0.08** → 3800 章约 **$304**（预算内）。成本按真实 input/output token 实时累计，达 70%/90% 告警。

---

## 🗂️ 仓库布局

```
Prime-Agent-Novel-Engine/
├── README.md                      # 本文档（项目级）
├── LICENSE
├── packages/
│   ├── agent/                     # Prime Agent 核心 agent
│   ├── ai/                        # AI 提供方接入（含 Agnes 注册于 models.generated.ts）
│   ├── coding-agent/              # 编码/研究智能体
│   │   ├── docs/                  # Prime Agent 文档（quickstart/usage/rlm/...）
│   │   └── skills/
│   │       └── novel-engine/      # ★ 小说创作引擎（详见其 README）
│   │           ├── SKILL.md
│   │           ├── README.md       # 小说创作详细手册
│   │           ├── docs/           # 使用/编写/优化/开发计划
│   │           ├── scripts/        # 启动脚本（start.sh / control/）
│   │           └── src/novel_engine/  # 包根 = 数据根（agents/core/engine/pipeline/quality/bible/config/chapters/...）
│   └── tui/                       # 终端 UI
```

---

## 📖 文档

- [Novel-Engine 详细手册](packages/coding-agent/skills/novel-engine/README.md) — 小说创作引擎完整说明（架构/配置/运行/扩展）
- [Prime Agent 文档](packages/coding-agent/docs/index.md)
  - [Quickstart](packages/coding-agent/docs/quickstart.md) — 安装、认证、首跑
  - [Usage / CLI](packages/coding-agent/docs/usage.md) — 命令、会话、自主上限、输出模式
  - [Long-running agents](packages/coding-agent/docs/long-running-agents.md) — 脱离/重接管、目标、心跳、调度
  - [RLM 编程模型](packages/coding-agent/docs/rlm.md) — 持久 IPython、子智能体、技能与信任模型
  - [JSON mode](packages/coding-agent/docs/json.md) / [RPC mode](packages/coding-agent/docs/rpc.md)
  - [Skills](packages/coding-agent/docs/skills.md) — 安装与创建可复用能力
  - [Provider setup](packages/coding-agent/docs/providers.md) — 订阅与 API‑key 提供方
  - [Architecture](packages/coding-agent/docs/architecture.md) — daemon/worker/kernel/持久化边界
  - [Development](packages/coding-agent/docs/development.md) — 从源码构建运行

---

## Acknowledgements

我们的 agent 与 TUI 构建于 [`pi`](https://github.com/earendil-works/pi) 之上，感谢其作者的宝贵工作。小说创作层（`novel-engine`）在此基础上落地了世界状态检索、多智能体写章与独立评审等能力。

## License

Prime Agent 完全开源，基于 [MIT License](LICENSE)。

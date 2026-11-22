# 仓库专精化卫生工作：让 clone 后的人无需考古即可配好密钥并启动小说生成

*   **Author:** I5858555255
*   **Status:** Executed（2026-11-22，commit `83f374a66` / PR https://github.com/I5858555255/Prime-Agent-Novel-Engine/pull/new/chore/repo-entry-hygiene）
*   **Date:** 2026-11-22

--------------------------------------------------------------------------------

## Overview

本仓库是两层结构：底层是 4 包 TS monorepo（`packages/{agent,ai,coding-agent,tui}`，Prime-Agent fork v0.7.1），上层是 Python 小说引擎（`packages/coding-agent/skills/novel-engine/src/novel_engine`，下简称 `src/novel_engine/`；文中裸 `src/` 相对引擎 skill 根 `packages/coding-agent/skills/novel-engine/`，裸 `config/` 相对 `src/novel_engine/`（即 `…/novel-engine/src/novel_engine/config/`））。引擎事实自包含：对底层 TS 包零 import，Python 入口只依赖 `novel_engine.*` 与第三方库。引擎有两条 Python 入口：`run_volume.py`（经 `noproxy_launcher.py` 脱离启动，现役 3800 章长跑入口，幂等对象）与 `production_runner.py`（经 `launch_prod.bat` 前台运行，调试/全量入口）。

本设计针对仓库的"入口与运行面"做一次卫生整理，使仓库对小说生成这个唯一用途而言：clone 后有顶层说明（当前根 `README.md` 为 0 字节）、密钥配置不靠猜（`.env.example` 与代码实际读取的变量名脱节，照抄会静默失败）、启动脚本可移植（`launch_prod.bat` 硬编码 `D:\AI\...` 绝对路径，`.env` 注入段缺 active profile 所需变量）。

范围严格保守：不改底层 TS 一行代码、不删包、不动 release 工具链、保留全部历史数据、不轮换密钥。

## The Problem

clone 本仓库的人要跑起小说生成，会依次撞上这些问题（经 EGM Goldfish 多轮零上下文评审对代码与 git 状态的实证核验）：

1. **没有入口说明。** 根 `README.md` 是 0 字节的 git 跟踪文件。新人只能靠读 `skills/novel-engine/` 下的十几份文档自行拼出运行链路。
2. **密钥配置照文档会静默失败。** 已入库的 `.env.example` 只列 `LLM_API_KEY`/`AGNES_API_KEY` 两个变量名，但 `config/llm_providers.json` 的 4 个 profile 实际用 3 个变量名（当前 active profile `agnes_30_token` 读的是 `AGNES_TOKEN_API_KEY`，该变量只在未跟踪的本地 `src/novel_engine/.env` 里）。代码侧 `production_runner` 路径的 `_resolve_api_key` 缺 key 时静默返回空串——进程能启动，到 LLM 调用处逐章 401，直到熔断才停。入口 B（`run_volume`）的失败形态更隐蔽：preflight `_check_keys` 只认 3 个 legacy 变量名（不含 active key），缺 legacy 名即 `exit(1)` 且报错名与 active 名不符；缺 active key 而配了 legacy 名时 preflight 通过、主链路空 key 逐章 401（`init_state` 的 `ConfigFatalError` 被 `except Exception` 吞掉）——"fail-fast"对 active key 不成立。
3. **启动脚本不可移植。** `launch_prod.bat`（已跟踪）硬编码 `D:\AI\Prime-Agent-Novel-Engine\...` 绝对路径，`.env` 查找是 CWD 相对（双击与终端调用行为不一致），且 `.env` 注入段缺 active profile 所需的 `AGNES_TOKEN_API_KEY`。注意：当前跟踪版（及入库历史 `77cfdf769`）均**不含**明文密钥段，"去密钥"对跟踪版是防御性 no-op。
4. **git 状态自相矛盾。** `launch_prod.bat` 已被 git 跟踪（commit `77cfdf769`），但根 `.gitignore` 第 55 行又把它列进"含密钥、绝不提交"块——gitignore 对已跟踪文件不生效，注释误导后人。
5. **冗余与泄密面。** 根目录 3 个未跟踪本地脚本（`launch_10.bat`、`launch_p0p1_3.bat`、`launch_10_wmi.ps1`）硬编码两把明文 key（`git log --all -S` 验证从未入 git 历史）；其中 WMI 脱离启动功能没有文档化的等价物指引（现役等价物是 `noproxy_launcher.py`，DETACHED|NO_WINDOW）。
6. **文档硬伤。** `SKILL.md` 第 40 行目录树引用了全仓库从未存在的 `使用说明指南.md`（真实文件为 `docs/使用说明.md`）；历史文档 4 处引用待删脚本或"从 bat 抠密钥"的配方，删脚本后成死链。

解决方案：一次纯文件级卫生变更——补写中文根 README 指针页、重写 `.env.example`、相对化 `launch_prod.bat`、删除 3 个本地脚本并修正 `.gitignore`、为历史引用加失效注记、勘误 `SKILL.md`。不引入新组件、不改代码行为。

## Goals

*   **G1（入口）**: clone 后根 `README.md` 在 50 行内给出：目录地图（全路径指针，不指废弃占位）、密钥配置三步、启动方式（前台 `launch_prod.bat` + 脱离 `noproxy_launcher.py`）、文档入口（HANDOFF.md）、TS 底层冻结边界声明。
*   **G2（可配置）**: `.env.example` 与 `llm_providers.json` 的 3 个变量名 + 1 个兼容残留逐条对应，写明两条入口各自的密钥加载位置与优先级链。承诺范围：入口 A 照抄即可配好；**入口 B 需双变量**（active 的 `AGNES_TOKEN_API_KEY` + 任一 preflight legacy 名如 `AGNES_API_KEY`，可同值），照单配齐才不静默失败。
*   **G3（可移植）**: `launch_prod.bat` 在任意目录的 fresh clone 上可启动并进入参数解析（`%~dp0` 相对化，去明文密钥，保持 CRLF + 纯 ASCII + 引号规范）。
*   **G4（干净根目录）**: 根目录 tracked 文件（`launch_prod.bat`/`.env.example`/`README.md`）中无 `sk-` 明文密钥；3 个含明文 key 的未跟踪本地脚本删除且不出现在任何暂存/跟踪状态；`launch_prod.bat` 保留 git 跟踪，`.gitignore` 注释与忽略行同步修正。（注：全仓 `git grep "sk-"` 74 条命中 / 46 个文件，全部为既有内容、本次操作不触碰；G4 检查只限定上述 3 个根目录 tracked 文件。）
*   **G5（无死链）**: 历史 tracked 文档 3 处脚本/密钥引用（`OPTIMIZATION_LOG.md`）+ 1 处本地未跟踪文件（`plans/2026-08-29`）各带失效注记；`SKILL.md` 目录树文件名勘误；质量日志正本指针在 README 中用全路径。
*   **G6（零侵入底层）**: `packages/*/src` 下 TS 代码零 diff；不改 release 工具链、不配置 upstream、不新增文档文件。

## Non-Goals

*   **NG1**: 不修改、不删除任何 `packages/*/src` 下的 TS 代码；不动 husky、release、publish 工具链；不配置 upstream remote 或漂移检测机制。
*   **NG2**: 不轮换、不删除本地明文密钥（`src/.env`、`src/novel_engine/.env` 保留现状）；不洗 git 历史。密钥暴露面收窄仅限删除 3 个未跟踪本地脚本（跟踪文件本就不含密钥段）。
*   **NG3**: 不删除 `docs/superpowers/quality-backlog.md` 与 `src/docs/superpowers/quality-backlog.md` 两个 268B 占位指针文件（内容已正确指向正本，同目录还有需保留的 `diagnostics-2026-10-02/` 历史数据）；不动该历史数据。
*   **NG4**: 不实现 pre-commit 按 stage 文件门控、仓库拆分/submodule、git-filter 瘦克隆（列为后续候选，见 Future Improvements）。
*   **NG5**: 不修代码层静默失败行为（`_resolve_api_key` 缺 key 返回空串 vs 文档声称 fail-fast 的矛盾）——本设计只在 README/`.env.example` 措辞上规避，行为修复另立项。
*   **NG6**: 不写英文文档；根 README 仅中文（作者决策）。

## Open Questions

*   **OQ1（已定稿）**: `biome check --write` 会自动改写底层 `.ts`，与 G6 零 diff 冲突。处置：验收前确认工作区干净；本地只跑 `tsgo --noEmit` + 引擎 pytest，完整 check 以 CI 为准；check 若产生底层 diff 一律撤销。
*   **OQ2（已定稿）**: `.gitignore` 第 54 行注释 + 第 55-58 行 4 条目（共 5 行）脚本忽略块整体删除；`launch_prod.bat` 相对化后不含密钥、保留跟踪；密钥面由第 13 行通用 `.env` 规则覆盖。

## Critical User Journeys (CUJs)

### CUJ 1: 新人 clone 后启动一次小说生成

*   **Given**: 全新 clone（Python 3.12 + 引擎依赖已装；`node_modules` 非必需），已按 README 三步配好密钥文件（入口 A：active profile 所需 `AGNES_TOKEN_API_KEY`；入口 B：`AGNES_TOKEN_API_KEY` + 任一 legacy 名 `AGNES_API_KEY`）。
*   **When**: 在任意目录（含路径带空格）运行 `launch_prod.bat`；脱离启动命令在引擎 `src/` 目录下执行（或先设 `PYTHONPATH=packages\coding-agent\skills\novel-engine\src`）：`python -X utf8 -m novel_engine.scripts.noproxy_launcher --chapters 1`。
*   **Then**: 前台脚本进入参数解析并打印配置摘要（无 `D:\AI` 残留、无 key 缺失报错）；脱离启动器打印 spawn 出的 PID 并退出 0，终端重启后该进程仍存活（DETACHED|NO_WINDOW；幂等探测依赖 `psutil`，缺失时检测禁用——每次启动打印提示后仍会 spawn，重跑可能双开——README 注明）。

### CUJ 2: 长跑不被 agent 终端重启杀死

*   **Given**: 3800 章生产运行中（经 `noproxy_launcher.py` 脱离启动 `run_volume`；`launch_prod.bat→production_runner` 为另一前台入口，不在幂等覆盖内，不可并行跑）。
*   **When**: 启动它的 agent/终端会话重启。
*   **Then**: 生成进程继续运行（DETACHED|NO_WINDOW，父进程 = 系统），重跑启动器幂等识别已有 `run_volume` 进程并退出 0（不会 spawn 第二个入口并行写 `state.db`/`chapters/`）。

## Technical Plan (Architecture)

本次变更不引入新组件，改动集中在 7 项操作（归 5 类文件面：配置模板 / 启动脚本 / 忽略规则与本地脚本清理 / 根文档 / 历史注记与勘误）。密钥与加载链的固化点如下。

### 密钥加载链（文档必须与代码一致，写死在 README/.env.example）

按入口分链：

```text
A) launch_prod.bat → production_runner → FailoverLLMClient → _resolve_api_key
   1. 进程环境变量（bat 从仓库根 .env 注入 3 个变量名，最高优先）
   2. src/.env（llm_client fallback，缺 key 时静默返回空串 → 逐章 401）

B) noproxy_launcher → run_volume → _load_env + ModelRouter
   1. src/novel_engine/.env（优先）
   2. src/.env（兜底）
   启动门（两道，均 profile-blind 或变量集不全）：
   - _check_keys：只认 LLM_API_KEY/AGNES_API_KEY/ZLEAP_MODEL_API_KEY 三选一，缺则 exit(1) 且报错名是这 3 个（不含 active 名 AGNES_TOKEN_API_KEY）
   - _check_api_connectivity：硬编码探测 SiliconFlow /v1/models，网络故障 exit(1)（401 不拦）
   缺 active key 而配了 legacy 名：preflight 通过，主链路空 key 逐章 401（init_state 的 ConfigFatalError 被 except 吞掉）

补充：
   env_bootstrap.load_project_env() 仅 tests/conftest.py 调用（测试专用，不进生产链）
   _resolve_api_key 次级 fallback 变量名 ZLEAP_API_KEY（当前配置不使用）
   active profile 权威源 = config/llm_providers.json 的 active_profile（当前 agnes_30_token；
   runtime_config.json 无此键，其 llm/fallback_llm 段由 switch_llm.py 同步而来）
   变量名字段 = llm_providers.json 各 profile 的 api_key_env（4 profile → 3 个变量名
   + 1 个兼容残留）：siliconflow→LLM_API_KEY；agnes/agnes_30→AGNES_API_KEY；
   agnes_30_token(active)→AGNES_TOKEN_API_KEY；ZLEAP_MODEL_API_KEY（from_config 默认参数 + run_volume._check_keys 启动门读取，active 主链路不用；保留以兼容旧脚本）
```
变更原则：

1. **`.env.example`（重写，tracked）**：UTF-8 无 BOM；按上面"3 个变量名 + 1 个兼容残留"逐条注释说明对应 profile 与所属入口链；`ZLEAP_MODEL_API_KEY` 注释为"仅 `llm_client.from_config` 默认参数与 `run_volume._check_keys` 启动门读取，active 主链路不用，保留以兼容旧脚本"；写明"本文件是变量清单模板，密钥实际写在 `src/novel_engine/.env`（入口 B 优先读，first-found 语义：该文件存在时 `src/.env` 不会被读取；需双变量写同一个文件：active 名 `AGNES_TOKEN_API_KEY` + 任一 legacy 名 `AGNES_API_KEY`，preflight 只认 3 个 legacy 名），仅当它缺失才落 `src/.env`（入口 A fallback / 入口 B 兜底），两文件均不入库"；删除"SiliconFlow 为主力"过期说法，改为"以 `config/llm_providers.json` 的 `active_profile` 为准，切换用 `config/switch_llm.py`（全路径 `packages/coding-agent/skills/novel-engine/src/novel_engine/config/switch_llm.py`）"。
2. **`launch_prod.bat`（修改，tracked，保留跟踪）**：所有路径改用 `%~dp0` 定位（脚本所在目录 = 仓库根）；当前 tracked 版无内嵌明文密钥段，"删密钥段"为防御性 no-op（写明"若有则删"）；`.env` 解析块改读 `%~dp0.env`，注入变量名由 2 个扩为 3 个：既有 `LLM_API_KEY`/`AGNES_API_KEY` + **本次新增** `AGNES_TOKEN_API_KEY`（active profile `agnes_30_token` 所需；这是行为变更，回滚会撤销）。`for /F` 用 `tokens=1,2`（防值前空格；值内含 `=` 的局限在脚本注释注明）；保持 CRLF、纯 ASCII、`set "VAR=…"` 与 `cd /d "…"` 引号规范。L33 预存缺陷（if 块内 `echo … (3800 chapters).` 未转义括号，base 版有参/无参均 exit 255）随本次一并转义修复（`^(3800 chapters^)`，最小复现实测）；G3 验收"无参启动无报错"的必需项。
3. **`.gitignore`（修改，tracked）**：整体删除"本地启动脚本含密钥"块（第 54 行注释 + 第 55-58 行 4 条目，共 5 行：`launch_prod.bat`/`launch_10.bat`/`launch_10_wmi.ps1`/`launch_p0p1_3.bat` 及其"never commit"注释）。`launch_prod.bat` 相对化后不含密钥、保留 git 跟踪；密钥面由第 13 行通用 `.env` 规则继续覆盖。
4. **3 个本地脚本（删除，untracked，文件系统操作、不进任何 commit）**：`launch_10.bat`、`launch_p0p1_3.bat`、`launch_10_wmi.ps1`。提交信息记录依据："3 个待删脚本中的 2 把明文 key 值经 `git log --all -S '<key值>'`（全 ref）验证从未入任何 commit（对 `sk-` 子串 pickaxe 有 99 个既有命中，不构成证据），故不轮换；WMI 脱离启动由 `noproxy_launcher.py`（DETACHED|NO_WINDOW，spawn `run_volume`，幂等识别既有 run_volume 进程；幂等探测依赖 `psutil`）等价接替"。
5. **根 `README.md`（补写，tracked，0→≤50 行中文）**：结构 = 项目一句话 → 目录地图（全路径指针表，含 `docs/superpowers/quality-backlog.md` 正本约 168 KB 唯一路径）→ 密钥配置三步（example→实际文件→active profile 变量名核对）→ 启动方式（前台/脱离两命令 + 幂重跑说明）→ 文档入口（HANDOFF.md 为现状入口）→ 边界声明（引擎自包含、TS 底层冻结不跟进上游、`prime-agent-runtime/` 是构建期拷入 dist 的 RLM（recursive LLM）运行时——IPython 持久内核 + 递归子智能体接口，非第二引擎，见 `packages/coding-agent/docs/rlm-runtime.md`）。不复述子 README 内容，全部指针化。
6. **失效注记（4 处，只加注不改写原文）**：`OPTIMIZATION_LOG.md`（tracked）第 15/93/144 行（均含 `launch_10.bat` 引用；其中 L15 是 R3 表格行）3 处；`docs/superpowers/plans/2026-08-29-novel-engine-efficiency.md`（**untracked，被 `.gitignore:38` 的 `plans/` 忽略**）第 764-765 行 1 处——该处注记仅本地生效，不进 commit。
7. **`SKILL.md` 勘误（修改，tracked）**：第 40 行目录树 `使用说明指南.md` → `使用说明.md`（按实际文件，历史存档 `使用方法指南.md` 一并列出）。

### 执行顺序（有依赖）

```text
⓪ 前置：OQ1/OQ2 已随本稿定稿（见 Open Questions"已定稿"标注）
① 重写 .env.example → ② 改 launch_prod.bat（依赖 ① 的变量名清单）
→ ③④⑤ 删 3 个本地脚本（untracked，文件系统操作，对应 Detailed Plan 项号 ③④⑤）→ ⑥ 修 .gitignore 54-58 行
→ ⑦ 写根 README（依赖 ①②⑥ 的最终形态，指针才准确）
→ ⑧ 3 处 tracked 注记（OPTIMIZATION_LOG）+ ⑩ SKILL.md 勘误（可与 ⑦ 并行）；⑨ plans 本地注记随手做，不进 commit
→ 验收（前置：工作区无底层 diff）
```

## Alternatives Considered

以下方案在 brainstorm 阶段被权衡并否决（来源：`concepts_brief.md` Alternatives Weighed + Goldfish 评审）：

### Alternative A: 激进重组（删除/移出 TS 底层，仓库改名全面转向小说引擎）

*   **Pros**: 仓库单一用途明确；clone 体积与 `npm run check` 负担大幅下降。
*   **Cons**: `prime-agent-runtime/` 是 coding-agent 构建链的一环（copy-assets `shx cp -r ../../prime-agent-runtime dist/`），删底层必须连构建脚本一起改，越出"卫生"边界；RLM 内核驱动引擎是已获批的未实现设计（`ARCHITECTURE_PRIME_AGENT_BASE.md`），现在删掉等于关闭这条路线；4 包还有被复用的现实价值。
*   **Reason for Rejection**: Rejected by author: 选择保守范围，只做入口与运行面整理，重组不进入本次工作。

### Alternative B: `git rm --cached launch_prod.bat`（脚本本地化，不入库）

*   **Pros**: 彻底消除"含密钥脚本入库"的隐患；.gitignore 注释块保持原样。
*   **Cons**: 相对化后的脚本不含密钥，没有理由不入库；一旦本地化，fresh clone 拿不到启动脚本，验收标准"G3/G4"（任意目录可启动）不成立，README 还需另写手工启动指令，增加第二套口径。
*   **Reason for Rejection**: 保留跟踪 + 相对化 + 去密钥 + 删 54-58 行忽略块，是同时满足"fresh clone 可启动"与"无明文密钥入库"的唯一解（跟踪文件本就不含密钥段，见 Problem 3）。

### Alternative C: 新建 `prime-agent-runtime/README.md` 澄清归属

*   **Pros**: 该目录自身有解释，新人点进去能看懂。
*   **Cons**: 现有 `packages/coding-agent/docs/rlm-runtime.md`（269 行）已覆盖；新开文档制造第三份需长期同步的材料——长期同步成本是本次文件清单里唯一的持续维护风险点。
*   **Reason for Rejection**: 根 README 一行指针足够，文档面不扩张。

### Alternative D: 删除两个 268B 占位 `quality-backlog.md`（`git rm`）

*   **Pros**: 少两个文件，消除"多副本"观感。
*   **Cons**: 占位内容已是正确指针，删除收益为零；`src/docs/superpowers/` 同目录住着要保留的 `diagnostics-2026-10-02/` 历史数据，误删风险大于收益；NG3 明确保留。
*   **Reason for Rejection**: Rejected by author: 保留占位与历史数据，指针全路径化写进 README。

### Alternative E: 验收保留"fresh clone 实跑一章"

*   **Pros**: 最接近"真能跑"的验证。
*   **Cons**: fresh clone 无密钥、无 Python 环境（需装 Python 3.12 + 引擎依赖），实跑需要密钥与网络，验收不可复现、不可离线。
*   **Reason for Rejection**: 验收改写为：脚本可启动 + tracked 文件无 `sk-` 明文（限定 3 个根目录文件 + 74 条既有假阳性基线声明）+ `:(glob)packages/*/src/**`（4 个 TS 包顶层 src）零 diff + 有密钥本地环境的一章冒烟。

### Alternative F: 本次顺带做 pre-commit 按 stage 文件门控

*   **Pros**: 引擎提交不被全仓 `npm run check` 拖慢——引擎开发速度被底层健康度绑架是现存真矛盾。
*   **Cons**: 越出"入口与运行面"边界；次生代价是底层失去"顺带 biome 修复"；门控逻辑本身需要单独设计与测试。
*   **Reason for Rejection**: 列为 Future Improvements 的第一候选，本次不做。

## Detailed Implementation Plan

### Target Files to Create/Modify

共 10 个编号项（口径以"文件"计）：**commit 含 6 个 tracked 文件**——① `.env.example`（重写）、② `launch_prod.bat`（相对化）、⑥ `.gitignore`（删 54-58 行块）、⑦ `README.md`（0→≤50 行内容）、⑧ `OPTIMIZATION_LOG.md`（3 处注记）、⑩ `SKILL.md`（勘误）；**3 项 untracked 脚本删除**（③④⑤，纯文件系统操作，不进 commit，仅在 commit 信息中记载）；**1 处本地注记**（⑨ `plans/2026-08-29`，被 `plans/` ignore 规则忽略，不进 commit）。

#### 1. `.env.example`（Modify，tracked）

*   **Type / Scope**: 配置模板
*   **Proposed Changes**: 整体重写。UTF-8 无 BOM（现状首 3 字节为 BOM，`EF BB BF`）。内容 = 标题注释（"变量清单模板；密钥实际写在 `src/novel_engine/.env`（入口 B 优先，first-found：该文件存在时 `src/.env` 不会被读取；需双变量写同一个文件）；仅当它缺失才落 `src/.env`（入口 A fallback / 入口 B 兜底），本文件不存放密钥"）+ 逐条列出：`LLM_API_KEY`（profile `siliconflow`）、`AGNES_API_KEY`（profile `agnes`/`agnes_30`）、`AGNES_TOKEN_API_KEY`（profile `agnes_30_token`，当前 active，见 `llm_providers.json` 的 `active_profile`）、`ZLEAP_MODEL_API_KEY`（`run_volume._check_keys` 启动门与 `llm_client.from_config` 默认参数读取；active 主链路不用；保留以兼容旧脚本）。占位值沿用现有 example 的 `your_xxx_api_key_here` 风格（不写 `sk-` 前缀，避免为 G4 假阳性基线新增噪音）。删除"SiliconFlow 为主力"说法，改为"以 `config/llm_providers.json` 的 `active_profile` 为准，切换用 `config/switch_llm.py`"。

#### 2. `launch_prod.bat`（Modify，tracked，保留跟踪）

*   **Type / Scope**: Windows 启动脚本
*   **Proposed Changes**: ① 所有 `D:\AI\...` 绝对路径改 `%~dp0` 前缀（字面全路径：`set "PYTHONPATH=%~dp0packages\coding-agent\skills\novel-engine\src"`、`cd /d "%~dp0packages\coding-agent\skills\novel-engine\src\novel_engine\pipeline"`、`set "LOG_FILE=%~dp0production_console.log"`；PYTHON 解释器维持 `python`（PATH 解析，与现行 tracked 版一致，不新增 `PYTHON_EXE` 变量面）；② 当前 tracked 版无内嵌明文密钥段，"删密钥段"为防御性 no-op（实现时 `findstr /C:"sk-" launch_prod.bat` 确认无命中后跳过）；③ `.env` 解析块改读 `%~dp0.env`，注入变量名扩为 3 个：既有 `LLM_API_KEY`/`AGNES_API_KEY` + 新增 `AGNES_TOKEN_API_KEY`（`for /F "usebackq tokens=1,2 delims==" %%a in ("%~dp0.env")` 引号包裹；值内含 `=` 的截断局限写进脚本注释）；④ 保持 CRLF、纯 ASCII（中文注释转英文或删）、`set "VAR=…"`/`cd /d "…"` 引号规范。`python production_runner.py %CHAPTERS% --real %START_FROM% %RESUME%` 调用形式保持不变。

#### 3. `launch_10.bat`（Delete，untracked）

*   **Proposed Changes**: 直接删除（`del`，不进 git 暂存——从未跟踪）。提交信息记录：3 个待删脚本中的 2 把明文 key 值经 `git log --all -S '<key值>'`（全 ref）验证从未入任何 commit（对 `sk-` 子串 pickaxe 有 99 个既有命中，不构成证据），故不轮换。

#### 4. `launch_p0p1_3.bat`（Delete，untracked）

*   **Proposed Changes**: 直接删除（同上，未跟踪；删除理由：路径写死 + 与 launch_prod 功能重复）。

#### 5. `launch_10_wmi.ps1`（Delete，untracked）

*   **Proposed Changes**: 直接删除（同上，未跟踪）。功能接替写入 README 启动章节：`noproxy_launcher.py`（DETACHED|NO_WINDOW，spawn `novel_engine.scripts.run_volume`，幂等识别既有 run_volume 进程——探测依赖 `psutil`，缺失时检测禁用、每次启动打印提示后仍会 spawn（重跑可能双开）；执行命令须在引擎 `src/` 目录下或先设 `PYTHONPATH=packages\coding-agent\skills\novel-engine\src`，见 `src/novel_engine/scripts/noproxy_launcher.py` 头注释）。

#### 6. `.gitignore`（Modify，tracked）

*   **Proposed Changes**: 整体删除"Local launch scripts with secrets"块（第 54 行注释 + 第 55-58 行 4 条目：`launch_prod.bat`/`launch_10.bat`/`launch_10_wmi.ps1`/`launch_p0p1_3.bat`）。不新增行：`launch_prod.bat` 相对化后无密钥、回归正常跟踪；密钥面由既有第 13 行 `.env` 规则覆盖。

#### 7. `README.md`（Modify 0 字节→≤50 行，tracked）

*   **Type / Scope**: 仓库入口文档（仅中文，指针页）
*   **Proposed Changes**: 章节结构（50 行硬上限）：
    1. 一句话定位（Prime-Agent fork 底座 + Python 小说引擎，本仓唯一用途 = 小说生成）。
    2. 目录地图表（全路径指针）：`packages/{agent,ai,coding-agent,tui}`（冻结底座，勿改）、`packages/coding-agent/skills/novel-engine/`（引擎本体，先读其 README）、`prime-agent-runtime/`（构建期拷入 dist 的 RLM（recursive LLM）运行时——IPython 持久内核 + 递归子智能体接口，非第二引擎，见 `packages/coding-agent/docs/rlm-runtime.md`）、`docs/superpowers/` 与引擎内 `src/docs/superpowers/`（两棵不同树）、质量日志正本唯一路径 `packages/coding-agent/skills/novel-engine/docs/superpowers/quality-backlog.md`（约 168 KB，条目置顶）、根目录 `OPTIMIZATION_LOG.md`（引擎优化轮次日志，tracked；其中 `launch_10.bat` 引用已加失效注记）。
    3. 密钥配置三步：`.env.example` → 按入口写入密钥文件（入口 B 脱离长跑写 `src/novel_engine/.env`，**双变量写同一个文件**：active 的 `AGNES_TOKEN_API_KEY` + 任一 legacy 名 `AGNES_API_KEY`（preflight `_check_keys` 只认 `LLM_API_KEY`/`AGNES_API_KEY`/`ZLEAP_MODEL_API_KEY` 三选一，缺 legacy 名即 `exit(1)`；可同值）；入口 A 前台写仓库根 `.env` 供 bat 注入——需含 active profile 所需变量（当前 `AGNES_TOKEN_API_KEY`）；两入口通用兜底 = `src/.env`（first-found 语义：入口 B 写 `src/novel_engine/.env` 时该文件存在即 `return`，不读 `src/.env`））；变量名对照 `llm_providers.json` 4 profile（3 名 + 1 兼容残留）；核对 active profile 看 `llm_providers.json` 的 `active_profile`（当前 `agnes_30_token`）。
    4. 启动方式：前台 `launch_prod.bat [chapters] [start_from] [resume]`（任意目录可跑，spawn `production_runner`）；脱离长跑：引擎 `src/` 目录下 `python -X utf8 -m novel_engine.scripts.noproxy_launcher --chapters N [--resume]`（幂等；agent 终端重启不杀进程；`psutil` 缺失时幂等检测禁用、每次打印提示后仍会 spawn——README 注明；入口 B 另有 `_check_api_connectivity` 硬编码 SiliconFlow 网络探测，网络故障 `exit(1)`——README 注明）。两入口不可并行跑。
    5. 文档入口：现状入口 = `packages/coding-agent/skills/novel-engine/docs/HANDOFF.md`；换书 = 同目录 `换书操作手册.md`；LLM 切换 = `packages/coding-agent/skills/novel-engine/src/novel_engine/config/switch_llm.py`（全路径，避免与 `scripts/control/select_llm.py` 混淆）；密钥说明 = `packages/coding-agent/skills/novel-engine/src/novel_engine/config/LLM选择器使用说明.md`（tracked，fresh clone 有；注意：该文档 L8 的"默认 profile"说法可能滞后，以 `llm_providers.json` 的 `active_profile` 为准）。
    6. 边界声明：引擎自包含（对 TS 包零 import）；TS 底层冻结不跟进上游不做 publish；`biome --write` 会改底层文件故本地只跑 `tsgo --noEmit` + 引擎 pytest；降级行为注明（`runtime_config.json` 缺失时 `llm_client` 静默返回 `{}` 走默认值；`psutil` 缺失时 launcher 幂等检测禁用——每次启动打印提示后仍会 spawn，重跑可能双开）。

#### 8. `OPTIMIZATION_LOG.md`（Modify，tracked，只加注）

*   **Proposed Changes**: 3 处各加一行失效注记（不改写原文）：第 15 行（R3 表格行，含 `launch_10.bat` 引用）、第 93 行（WMI 示例命令）、第 144 行（启动描述）：紧随该行加 `> [已失效 2026-11-22] launch_10.bat 已删除；脱离启动等价物 = noproxy_launcher.py（见 README）`。

#### 9. `docs/superpowers/plans/2026-08-29-novel-engine-efficiency.md`（本地文件，untracked/ignored，只加注）

*   **Proposed Changes**: 在 L763（powershell 围栏开栏）之上、L762 引言行之后插入 1 行注记（仅本地生效，不进 commit；不可加在 764-765 行上方——会落进围栏内渲染为代码行）：`> [已失效 2026-11-22] 该配方从 launch_prod.bat 内嵌 ZLEAP/AGNES 明文段读取密钥；现脚本已无内嵌密钥段（改为从仓库根 .env 解析 3 个变量名），配方不可用；密钥实际位于 src/novel_engine/.env（run_volume 主加载）与 src/.env（引导/fallback）`。

#### 10. `packages/coding-agent/skills/novel-engine/SKILL.md`（Modify，tracked）

*   **Proposed Changes**: 第 40 行目录树 `使用说明指南.md` → `使用说明.md`（现役）并补 `使用方法指南.md`（历史存档）一行；不改目录树其他行（目录树系统性漏列 10 个现存文档的问题不在 G5 范围，列入 Future Improvements）。

### Verification Plan

按执行顺序逐项验证，全部通过后方可提交：

*   **前置（OQ 已定稿）**: 工作区 `:(glob)packages/*/src/**`（4 个 TS 包顶层 src）无未提交 diff；OQ1/OQ2 按 Open Questions 定稿执行。
*   **脚本可启动（G3/CUJ-1）**: ① 仓库根执行 `cmd /c launch_prod.bat`（不带参数）：只验证 echo 配置块（Chapters/Start/Resume/Log 打印），输出中无 `D:\AI` 字符串、无 key 缺失报错，随后 Ctrl-C 中止在 LLM 循环前（不算失败）；② `%~dp0` 可移植性：把**整个仓库**复制/clone 到含空格路径的目录（单拷 bat 无意义，其所有路径已相对脚本目录），在副本仓库根重复 ①。
*   **tracked 文件无明文 key（G4）**: `git grep "sk-" -- launch_prod.bat .env.example README.md` 无真实 key 命中；`git status --porcelain` 中 3 个 launch 脚本不出现在任何暂存/跟踪状态。声明：全仓 `git grep "sk-"` 74 条命中 / 46 个文件，全部为既有内容、本次操作不触碰；G4 检查只限定上述 3 个根目录 tracked 文件。
*   **底层零 diff（G6）**: `git diff --stat -- ':(glob)packages/*/src/**'` 为空（glob-magic 限定 4 个 TS 包顶层 src；plain pathspec `packages/*/src` 实测匹配 0 文件、恒真，禁用）；执行前自检 `git ls-files ':(glob)packages/*/src/**' | wc -l` 应为 366；确认未跑过 `biome --write`（或已撤销其产物）。
*   **静态检查（OQ1）**: 本地跑 `npx tsgo --noEmit`（需先 `npm ci` 装出 node_modules/.bin；fresh clone 无 node_modules 时此步跳过、以 CI 为准）；完整 `npm run check` 以 CI 结果为准（`check:installer` 需 `sh`，Windows 本地不可用）。
*   **引擎测试（G6 副作用兜底）**: 先 `set PYTHONPATH=packages\coding-agent\skills\novel-engine\src`；实施前跑一次 `python -m pytest .../src/novel_engine/tests/ -q` 并把该次实际写出的 `lastfailed`（命令所在 src 目录的 `.pytest_cache/v/cache/lastfailed`，勿硬编码数字）复制为基线文件；实施后同命令同位置再跑，diff 两份 `lastfailed`，零新增失败即通过。（实际基线：CWD=src 下 1302 passed / 0 failed / 1 xfailed，无 lastfailed；spec 初稿"当前快照 5 项"假设不成立，按"零新增失败"口径验收通过。）
*   **一章冒烟（CUJ-1 Then）**: 有本地密钥环境（仓库根 `.env` 含 active profile 所需 `AGNES_TOKEN_API_KEY`）跑 `launch_prod.bat 1 1 0`，生成 1 章且无 401（验证 bat 注入段新增变量生效；入口 A 只读进程 env 与 `src/.env`，不读 `src/novel_engine/.env`）。
*   **文档一致性（G5）**: 新开会话只读根 README，按"密钥三步"能定位到正确的入口-文件-变量名对应（人工走查：密钥三步、Python 3.12+依赖安装、前台启动命令、脱离启动命令与 CWD 前提、TS 底层冻结边界声明——5 项）。
*   **提交**: 单一 commit = 6 个 tracked 文件（逐个 `git add <path>`，禁用 `-A`，避免带入 `concepts_brief.md`/`design_draft.md`/`docs/designs/` 等现存 untracked 物）；commit 信息含依据记录（3 个待删脚本中的 2 把明文 key 值经 `git log --all -S '<key值>'`（全 ref）验证从未入任何 commit（对 `sk-` 子串 pickaxe 有 99 个既有命中，不构成证据），故不轮换；WMI 脱离启动由 noproxy_launcher 接替；3 处 tracked 注记 + 1 处本地注记位置；3 个 untracked 脚本已删除）。暂存核对：`git status` 暂存区 = 且仅 = 上述 6 文件。

## Non-Functional Requirements

*   **Security & Privacy**: 本次变更删除 3 个含明文 key 的未跟踪本地脚本（跟踪文件本就不含密钥段，`launch_prod.bat` 改后亦无），不洗 git 历史、不轮换密钥（作者决策；依据：3 个待删脚本中的 2 把明文 key 值经 `git log --all -S '<key值>'`（全 ref）验证从未入任何 commit（对 `sk-` 子串 pickaxe 有 99 个既有命中，不构成证据）；仓库已推 GitHub 但推送的是 tracked 文件、不含这些 key，故推送不构成暴露，删除脚本后 key 仅存在于本地 `.env`，"不轮换"为作者知情决策）。`.env` 类文件维持既有 ignore 规则。
*   **Rollback**: commit（6 tracked 文件）回滚 = `git revert` 一笔；3 个 untracked 脚本删除为文件系统操作，`git revert` 不恢复（内容不入库、无备份——WMI 配方永久丢失，等价物 noproxy_launcher 已文档化，接受此风险）。

## Risks & Limits

*   **降级行为（设计内，非缺陷）**: `runtime_config.json` 缺失时 `llm_client._load_runtime_config()` 静默返回 `{}`（设计内静默降级）；`psutil` 缺失时 `noproxy_launcher` 幂等探测禁用（每次启动打印提示后仍会 spawn，重跑可能双开——非静默）。两条都在 README 边界声明中注明。
*   **失败形态因入口而异（已按 active key 复核）**: 入口 A（production_runner）缺 key 静默逐章 401 至熔断。入口 B（run_volume）有两道 preflight 启动门（`_check_keys`：只认 3 个 legacy 变量名，缺 legacy 名 `exit(1)`；`_check_api_connectivity`：硬编码 SiliconFlow 探测，profile-blind，网络故障 `exit(1)`、401 不拦）+ 一道主链路 profile 校验（`ModelRouter._validate_profile` 认 active 的 `api_key_env`，但缺 active key 的错误被 `init_state` 的 `except Exception` 吞掉 → 退化为逐章 401）。"fail-fast"仅对 legacy 名与网络门成立，对 active key 不成立——入口 B 需双变量配置（见 README §3）。
*   **bat 局限**: `for /F tokens=1,2 delims==` 不防值内含 `=` 截断（当前 key 值无 `=`，脚本注释注明）；GBK 代码页下中文注释会损坏，故 bat 保持纯 ASCII。
*   **可扩展性上限**: 引擎"自包含"是本设计反复引用但由 README 声明承载的承诺，无自动化检查（pre-commit 门控/目录隔离均未做）；若未来底层与引擎开始互相 import，"冻结"承诺即失效——列入 Future Improvements。

## Future Improvements

*   **pre-commit 按 stage 文件门控**：引擎提交跳过全仓 `npm run check`（biome 全仓 + tsgo + 冒烟），混合提交才全跑。真矛盾：引擎开发速度被底层健康度绑架。次生代价：底层失去"顺带 biome 修复"。
*   **TS 底层冻结的漂移体检节奏**：仓库无 upstream remote，冻结后依赖腐烂隐性化；加月度手动检查（上游 changelog + 引擎是否需要底层新功能）。
*   **仓库拆分评估**：引擎"自包含"已由本设计 README 声明固化，拆独立仓库/submodule 成本降至路径替换级别；`.git` 131M 的 git-filter 瘦克隆可并行评估。
*   **代码层小修（各另立项）**: ① `_resolve_api_key` 缺 key 静默返回空串 → 改为报错并打印缺失变量名（仅入口 A 路径）；② `run_volume._check_keys` 扩展为读 `llm_providers.json` active profile 的 `api_key_env`（消除入口 B 双变量需求与 legacy 名报错误导）；③ `_check_api_connectivity` 硬编码 SiliconFlow URL → 改为按 active profile 的 `base_url` 探测；④ `SKILL.md` 目录树系统性漏列 10 个现存文档（本次 G5 只修 L40 错名，不扩改）；⑤ `switch_llm.py:115` "AGNES_API_KEY 常驻 .env" 不变量注释随 profile 切换已过期；⑥ `LLM选择器使用说明.md` L8 "当前默认 agnes（AGNES_API_KEY）/ 硅基流动已停用" 段落过期（实际 active = `agnes_30_token` / `AGNES_TOKEN_API_KEY`，siliconflow profile 仍在 `llm_providers.json`），随 profile 切换机制刷新。

--------------------------------------------------------------------------------

*Drafted with EGM*

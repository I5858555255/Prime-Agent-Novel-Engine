# PANE 交接说明（HANDOFF）

> 给"下一个接手 agent"的唯一现状入口。历史操作细节在 `docs/superpowers/quality-backlog.md`（条目置顶、按日期倒序），本文件只写**现在是什么状态、接下来做什么、别踩什么坑**。
>
> 最后更新：2026-11-08 00:40 +0800。第 3 节是**快照**，批次在跑，数字会漂；动手前先按第 5 节第 1 步核对最新日志。

---

## 0. 一句话现状

3800 章规划，中纲已铺到 **ch1756 且 30/30 approved**（V05 两条 forbidden 已条款化为 R18/R19），实际跑到 **ch1716**。当前批次 `run_1726`（PID 24492）已出 21 章（ch1682-1715）：20 上岸、1 失败，**均分 69.1（发布线 88）**。代码侧有本轮未提交改动（V05 判例、否定语境修复、`status_snapshot.py`），门禁已过（1302 passed / 1 xfailed、pyflakes 0 undefined）。

---

## 1. 项目与运行环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine` |
| 分支 | `feat/stability-quality`（远端 `origin` 同名分支，已 push，ahead=0） |
| 最近提交 | 见 `git log -1 --oneline`；本轮之前是 `57b0e4ace docs`（父 `f38029fc7` 危机门修复）。**本轮 V05 判例 + 否定语境修复 + status_snapshot 已过门禁、待提交** |
| 技能包根 | `packages\coding-agent\skills\novel-engine\` |
| 数据根 = 包根 | `...\skills\novel-engine\src\novel_engine\` |
| **运行/测试工作目录** | `...\skills\novel-engine\src`（不是仓库根，也不是包根） |
| Python | `D:\Program Files\Python312\python.exe`，一律加 `-X utf8` |
| 当前模型 | `config/llm_providers.json` 的 `active_profile = agnes_30_token`，各 phase 均 `agnes-3.0-flash`，端点 `https://apihub.agnes-ai.com` |
| 密钥 | 只放 `src/novel_engine/.env`，变量名随 profile：当前 `AGNES_TOKEN_API_KEY`；禁止写进 json |
| Shell | Windows + pwsh7。Bash 工具在本机不可用 |

---

## 2. 本阶段任务与状态

用户在本阶段交办了三件事，状态如下：

| # | 任务 | 状态 |
|---|---|---|
| 1 | 修 ch1682 跨场危机门误判（"召唤动作+紧急谓词"被否定句/单字"走"误触发） | **已完成**，提交 `f38029fc7`，已 push，门禁 6 passed + 378 passed/1 xfailed |
| 2 | 把任务/进度/目标写进项目，供其它 agent 接管 | **本文件** |
| 3 | 盘点项目是否缺必要记录 | 见第 7 节，缺口已列出，部分已补 |

接手后**不要重做 1**；从第 5 节的执行顺序继续。

### 2.1 那次修复改了什么（避免被误判为"没生效"）

- 文件：`src/novel_engine/quality/cross_scene_crisis_gate.py`；新测试 `tests/domain_gate_wiring/test_crisis_gate_negation.py`（6 例）。
- 改动：新增否定语境 `_NEG_SUFFIX`（只收"并未/没有/不曾/从未/不再/不是/毫无/无须/不用/不必/别/勿/莫"等明确否定组合，**单字"不/未/无"刻意不收**，否则会漏报真危机）；新增 `_kw_hit()` 统一做"前 8 字否定前缀"检查；`_CRISIS_PREDICATES` 删掉单字"走"，改收"快走/赶紧走/走啊/快走开/快回去"；"快"排除"很快/尽快/痛快"等复合词。
- **重要**：`run_1726` 进程是 22:08 启动的，Python 已 import 旧模块，本次修复**对这一批不生效**。只有新起的进程才用新逻辑。ch1682 在这一批以 62.3 上岸，是重生成正文本身不再含那条触发句，不是修复生效。

---

## 3. 当前进度（实测数字，2026-11-07 23:50）

### 3.1 总量与卷划分

`config/planning/volumes.json`，10 卷共 3800 章（`runtime_config.json` 的 `pipeline.total_chapters=3800`）：

| 卷 | 标题 | 章范围 |
|---|---|---|
| V01 | 昆仑遗子 | 1-316 |
| V02 | 大乾人间 | 317-652 |
| V03 | 仙门初渡 | 653-988 |
| V04 | 万山寻仙 | 989-1422 |
| V05 | 人间藏仙 | 1423-1843 |
| V06 | 阴阳双界 | 1844-2200 |
| V07 | 天门之后 | 2201-2600 |
| V08 | 仙门旧墟 | 2601-3000 |
| V09 | 伐天人皇 | 3001-3400 |
| V10 | 人道定仙天 | 3401-3800 |

当前在 **V05（1423-1843）**的后段。

### 3.2 中纲（章级意图）覆盖

`config/planning/mid_outline_*.json` 共 **58 个分片**（每片 30 章，个别早期片 26 章）：

- V01：ch21-316，10 片（**ch1-20 没有中纲**，早期章靠 plot_graph，属正常）
- V02 标签：ch317-706，13 片
- V03 标签：ch707-1726，34 片
- **V05：ch1727-1756，1 片**（`mid_outline_V05_ch1727-1756.json`，真实卷号命名，30/30 approved）

**文件名里的 `V0x` 前缀不能当卷依据**：例如 `mid_outline_V03_ch1697-1726.json` 实际落在 V05 的章号段。加载逻辑（`chapter_director._load_mid_outline_entry`）是**扫全目录、按章号匹配 entry**，不看文件名前缀，所以功能上无影响；写新片时请用真实卷号，别再延续错标签。

最新一片 `mid_outline_V05_ch1727-1756.json`：`meta.status=approved`，30 条 entry 全部 `approved`（详见 backlog 2026-11-08 条目）。

门禁规则：`entry.status` 存在时以其为准，只有 `approved` 会被注入 director；`pending_human` / `needs_regenerate` 的章退回"松散参考"（不阻塞批次，但失去强约束）。`entry.status` 缺失的旧文件才看 `meta.status`，`draft` 一律不可用。

**写中纲时的两个真实坑**（本轮踩过）：

- `boundary_note` 里出现"需人工确认"字样 → `audit_mid_outline` 第 439 行直接判 `pending_human`，形成**永久 pending**。要确认的内容请直接写成陈述式结论（如"铺垫：摄魂阁暗探线推进，不揭露组织目的"）。
- `boundary_note` 引用 `f00X` / fid 时，core_event 必须命中该实体的 `anchors`（`config/foreshadow/registry.json`），否则报"锚点未命中，疑似编号标错"。引用前先核对锚点词表。

### 3.3 已完成章与产物

| 指标 | 实测值（2026-11-08 00:30 快照，`status_snapshot.py` 输出） |
|---|---|
| `runtime/checkpoint.json` | `{checkpoints: 1739, last_complete: 1715, failure_counts: {"370":13,"867":1,"883":1,"1709":1}, skipped_chapters: [370]}`；去重后 **1713 个唯一章** |
| `chapters/draft/*.txt` | **1681 个**（编号 6..1715） |
| `chapters/novel/*.txt` | **234 个**（编号 1..1649，很稀疏） |
| `chapters/draft/failed/` | **49 个**章目录 |
| `runtime/state_machine.json` | `current_chapter=1716`、`total_target=3800`、`phase=POLISH`、`next_state=REVIEW` |

**查最新状态不用手工盘点**：工作目录 `...\src` 下

```powershell
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.status_snapshot --out "$env:TEMP\_snap.md"
```

只读，不改任何状态；输出 checkpoint/产物/中纲/最近批次均分与最低 5 章/StateDB 行数/下一步命令。

**draft 与 novel 不是一回事，这是最容易误读的地方**：

- `chapters/novel/` 只放**达到发布线（88）**或 gray-band 授权发布的章。
- 88 以下但 hard gate 为空的章，走 `_force_publish_best`：正文落 **`chapters/draft/`**，写一条 `mode=force_best_draft` 的 checkpoint（`core/checkpoint.py:create_draft_checkpoint`，只校验 draft/），`run_volume` 日志里照样打 **COMMITTED**。
- 所以"COMMITTED"= 已提交 checkpoint，**不等于**已进 novel/。
- 本批 16 个 COMMITTED 里，多数是 draft（日志 note 形如 `best 79.5 < 88`）。novel/ 只有 234 章，而 checkpoint 有 1709 章，差距就来自这里。

`runtime/checkpoint.json` 里另有 33 条 checkpoint 找不到对应 draft（多为 ch1-100 老章，正文在 novel/ 或已被清理）；1 条 draft 无 checkpoint（ch1709，见 3.4）。属历史产物不一致，不是新故障，暂时不影响续跑（resume 以 checkpoint 为准）。

`ch370` 累计 13 次失败后被写入 `skipped_chapters`，**永久跳过**。除非用户明确要求，不要重跑它。

`runtime/state.db`（StateDB，53 KB + 4 MB WAL）：`characters` 8、`factions` 0、`foreshadows` 9、`clue_plans` 20、`relationships` 6、`concept_unlocks` 4。查实时库前先复制一份再查，别在跑批时直连。

### 3.4 当前批次 run_1726（接手时的"现场"）

| 项 | 值 |
|---|---|
| 进程 | PID **24492**（`python.exe`，2026-11-07 22:08:34 启动） |
| 命令 | `"D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.run_volume --chapters 1726 --resume` |
| 工作目录 | `...\skills\novel-engine\src` |
| 运行日志 | `src\novel_engine\runtime\run_volume_20261107T140835Z.log`（每章 START/END 一行） |
| 包装日志 | `C:\Users\ZHANG\AppData\Local\Temp\run_1726_batch.log`（含 +0800 时间戳，看进度更快） |
| 启动时 checkpoint | 1693 章已 COMMITTED，跨批失败计数 `[(370,13),(867,1),(883,1),(1682,1),(1688,1)]` |
| 已出结果（ch1682..1715，21 章，00:30 快照） | COMMITTED 20 / FAILED 1；均分 **69.1**；最高 ch1700 83.7 |
| 最低 5 章 | 1699 **42.4**、1713 **52.4**、1698 **53.2**、1682 62.3、1702 66.7 |
| 失败章 | ch1709，69.0，note=「三评极差>15，评审极不稳定，强制人工复核（不自动重采）」 |
| 当前 | 00:26 完成 ch1715（70.0），已启动 ch1716，进程仍在跑 |

这批的**质量信号很差**：均分 69.1，且 42.4/52.4/53.2 这种分数也直接 COMMITTED 了。原因见第 4 节：force-best 会无条件兜底到 draft。

`--chapters 1726` 表示"跑到第 1726 章为止"，`--resume` 表示跳过 checkpoint 里已 COMMITTED 的章。若进程中途死掉，直接重跑同一命令即可（不要 `--chapters 1727` 起新窗口，`--resume` 会自己从第一个缺口开始）。

---

## 4. 质量判定规则（按代码真实行为写，不是按文档）

配置在 `config/runtime_config.json` 的 `quality` 段：`pass_threshold=88`、`fix_threshold=60`、`publication_line=88`、`min_chapter_score=60`、`min_pacing=7.5`、`min_innovation=7.0`、`target_avg_score=88`。

`pipeline/pipeline_orchestrator.py` 收尾分支（约 986-1031 行）的实际行为：

1. **best ≥ 发布线，且 hard gate 全过** → `success=True`，`apply_world_state=True`，发布 `chapters/novel/`。
2. **best ≥ 发布线，但 hard gate 仍阻断** → `force publish`：`success=True`，附 note，标人工复核，发布路径受 `_force_publish_best` 控制。
3. **best < 发布线，且不在 gray-band** → **force-best 到 draft**：`success=True`、`published=True`、`apply_world_state=False`，note 形如 `best 42.4 < 88 (hard gate [])`，同时 `_flag_for_human`。**这是 88 以下也能"上岸"的机制来源，不是 bug，是现行设计（给人工审阅用）**。
4. **gray-band**：`soft_publication_line = min_ch - 3`，落在 [soft, 88) 且无 high issue、det 通过 → 授权发布 novel/ 并标"抽读复核"（ch62 那类问题的产物）。
5. **评审极不稳定**：两次评审极差 >15 → 直接 FAILED，强制人工复核，不自动重采（ch1709 就是）。
6. 82-87 分另有一条"人工复核队列"路径（落 draft + `pending_human_review`），与 force-best 并列。

推论：**看 `run_volume` 日志的 COMMITTED 数量不能判断质量，必须看分数和 note**。均分 69 而 checkpoint 一路涨，是这套兜底的正常表现，也是当前最大隐患。

---

## 5. 接手后的执行顺序

### 第 1 步：等 `run_1726` 收敛

- 看 `C:\Users\ZHANG\AppData\Local\Temp\run_1726_batch.log` 尾部，或 `runtime\run_volume_20261107T140835Z.log` 里的 `=== START/END chapter N ===`。
- 完成标志：日志出现收尾 `SUMMARY`（或进程退出、`Get-CimInstance Win32_Process` 里 PID 24492 消失），且最后一章是 ch1726。
- 收敛后核对：`checkpoint.last_complete` 应到 1726；新增 FAILED 章要记进 backlog。
- **不要**在它还在跑时启动第二个批次：两个进程共用 `runtime/checkpoint.json`、`state.db`、`chapters/`，会互相覆盖。

### 第 2 步：生成 ch1727-1756 中纲并审 —— **已完成（2026-11-08 00:35）**

文件 `config/planning/mid_outline_V05_ch1727-1756.json`，30/30 approved，`meta.status=approved`。复现/重审命令（工作目录 `...\skills\novel-engine\src`）：

```powershell
# 生成（--vid 用真实卷号：1727 属 V05）；仅在需要重做时执行
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.generate_mid_outline `
  --vid V05 --start 1727 --end 1756 --batch-size 6

# 校验并写回 entry.status（加 --no-write 则只报告）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.audit_mid_outline `
  config/planning/mid_outline_V05_ch1727-1756.json
```

- 默认输出 `config/planning/mid_outline_<vid>_ch<start>-<end>.json`，可用 `--out` 覆盖。
- `audit_mid_outline` 参数是**位置参数**：给文件路径，或给 `auto`（会取 `config/planning/` 下排序第一的文件，**不是**"全部"，别误用）。
- 有 `needs_regenerate` 的章：`generate_mid_outline --vid V05 --start ... --end ... --only 1731,1735 --out <同一个文件>`（`--only` 会合并进已有文件），再跑一次 audit。
- **API key**：`generate_mid_outline.py` 只认 `AGNES_API_KEY` / `LLM_API_KEY`。当前 `.env` 第 5 行 `AGNES_API_KEY` 与第 8 行 `AGNES_TOKEN_API_KEY` 并存，实测直接跑**不会**退 2（此前"必须设别名"的说法不成立；但换 profile 时仍建议先 `$env:AGNES_API_KEY = $env:AGNES_TOKEN_API_KEY`）。密钥只走环境变量，不写进任何 json。
- 通过标准：30 条 entry 全 `approved`，`meta.status=approved`。**注意**：`[概念规划] V05 不在 concept_unlocks.unlock_schedule` 是提示级，不阻塞；见 8.10。

### 第 3 步：启动下一批（**当前批次收敛后**才可执行）

```powershell
Set-Location "D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine\packages\coding-agent\skills\novel-engine\src"
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.run_volume --chapters 1756 --resume
```

- 新进程会 import 最新代码（含 `f38029fc7` 的危机门修复），这是修复真正生效的时点。
- `--skip-after N`（默认 5）控制"跨批累计失败多少次后放弃该章"；ch370 已达 13 次，属历史遗留。
- 日志自动落 `runtime/run_volume_<UTC时间戳>.log`；建议同时用 `Tee-Object` 或重定向到 `%TEMP%` 便于 tail。
- 长跑建议放后台/独立窗口，避免与本会话工具超时绑定。

### 第 4 步：验收并记账

- 抽 END 行统计：COMMITTED/FAILED、均分、最低 5 章、<60 的章清单。
- 对 <60 的章：确认是 force-best draft（note 里 `best X < 88`），进人工复核队列，不当作成功。
- 把本批结论写进 `docs/superpowers/quality-backlog.md` **顶部**（新条目置顶、标日期），格式照现有条目。
- 代码有改动才提交：只 `git add` 本次改动路径，跑门禁（见第 6 节），push 到 `origin/feat/stability-quality`。

---

## 6. 硬约束（违反会直接破坏项目）

1. **A 路线 #8（创作硬边界）**：第一阶段陆烬**禁止任何修炼样式动作**（静坐吐纳、引气、气流流转、暖意、气感、呼吸法调心神、夜间独坐静神、模仿引导动作）。合法形态只有"陈老根习练 + 陆烬旁观/被波及/阅读记录"。已实锤越界章：ch1634、1647、1676、1690、1695、1710、1713、1717、1719、1720。写新中纲/新章前先对照这一条。
2. **git 纪律**：禁 `git add -A` / `git add .` / `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `git commit --no-verify`。只 add 自己改的具体文件。CRLF→LF 警告无害。
3. **门禁**：改动质量门/门禁代码后，在 `src` 下跑
   `python -X utf8 -m pytest novel_engine/tests/domain_gate_wiring -q`（历史基线 378 passed, 1 xfailed, ~112s），以及受影响的专项目录（`domain_low_score`、`domain_rescue_remediation`、`domain_punctuation`、`domain_review_hybrid` 等）。本次修复另跑 `tests/domain_gate_wiring/test_crisis_gate_negation.py`（6 passed）。
4. **cron**：批次接力由既有定时任务负责（`13959628902658`，`23 */3 * * *`，Asia/Shanghai，enabled）。**本链不新建、不删除、不修改任何定时任务**。另曾出现 `13628799289858`、`13657835483138`、`14072832100610` 三个定时触发注入，同样不要动。
5. **API key**：只通过 `$env:` 注入或 `.env`，不写进 json、不写进文档、不写进 commit。
6. **提交前先看 `git status`**，确认只暂存自己的文件；批次进程与 git 共用同一工作区，切换代码后**必须新进程**才生效。

---

## 7. 记录体系盘点（这一节回答"项目缺什么记录"）

### 7.1 现有记录

| 文件 | 大小 | 状态 |
|---|---|---|
| `docs/superpowers/quality-backlog.md` | ~156 KB | **唯一权威操作日志**，条目置顶、按日期倒序。历史决策、根因、修复、验证都在这里 |
| `docs/superpowers/project-status-issues-20261012.md` | 6.2 KB | 2026-10-12 时点快照，已落后近一个月 |
| `docs/superpowers/orchestrator-boundaries.md` | 6.0 KB | 编排边界说明，仍可参考 |
| `docs/superpowers/beats-pilot-30.md` | 5.1 KB | 早期 30 章 beats 试点 |
| `docs/superpowers/plans/` | 目录 | 历史计划 |
| **`docs/HANDOFF.md`** | 本文件 | **本次新建** |

### 7.2 缺口（本次已补 / 仍缺）

已补：

- **没有交接文档** → 本文件。
- **`README.md` 是 0 字节** → 已写最小入口（项目是什么、代码在哪、从哪读起）。
- **`docs/runbook.md` 严重过期** → 已在文首加"已过时"警示并指向本文件；正文未逐条重写（内容与现状差距太大，重写属于下一项独立任务）。
- **`quality-backlog.md` 缺"入口"** → 已在顶部加一行指针，指向本文件。
- **`SKILL.md` 目录树过期**（写着 `planning/`、`foreshadow/`、`simulation/` 是顶层目录）→ 已订正为实际结构（这三者在 `config/` 下，且不存在这些顶层目录）。

仍缺（建议后续补，但本轮未做，避免越界）：

| 缺口 | 影响 | 建议 |
|---|---|---|
| ~~没有"当前状态快照"文件~~ | 已补：`scripts/status_snapshot.py`（只读，输出 Markdown；00:30 那版见第 3.3 节） | 每批收敛后跑一次，必要时贴进第 3 节 |
| 没有"质量趋势"记录（各批均分、低于 60 章走势） | 看不到"越跑越差"还是"偶发" | 从 `run_volume_*.log` 的 END 行做一个小脚本，产出 `audit/batch_quality.csv` |
| `needs_human_review.json` 队列没人消费 | 低分 draft 越积越多（本批已 +8 章 <70） | 先定"谁审、按什么顺序审、审完怎么回写" |
| `docs/runbook.md` 正文 | 会把人带到 SiliconFlow/Qwen、16 passed、200 章出口的旧世界 | 需要一次整体重写（下一项独立任务） |
| 中纲 `V0x` 标签与真实卷号错位 | 人类阅读时容易误判进度 | 新片用真实卷号；历史片不批量改名（改名会动 git 历史且无功能收益） |
| `chapters/outline/` 只有 39 个 task_card 快照 | 无法复盘"当时按什么卡写的" | 如需复盘再补，非阻塞 |

---

## 8. 待决事项（需要用户拍板，别自行决定）

1. **本批均分 69.8 怎么处理**：是继续按 cron 接力往下推（接受大量 draft），还是先停下来做质量治理？这是当前最重要的决策点。
2. **低于 60 分的章是否补写**：ch1699(42.4)、ch1698(53.2)、ch1682(62.3) 等都在 draft，未进 novel。
3. **ch1709 人工复核**：三评极差>15，需要人或模型复评一次。
4. **writer 输出退化**（短篇、分词碎裂成单字行、复读"尸位素餐"十余次）：ch1682 原始稿的 15.5 分主因，尚无归因与修复方案。是否作为下一项机制任务？
5. **dim-gate 长度严重不足**（`[长度] 5078 < 7310`）：ch1688、ch1698 都出现过，属系统性问题，是否改 dim-gate 策略或人工补写？
6. **`稳固神魂` 类防御性调息**是否算 A 路线 #8 禁项（当前从严处理）。
7. **ch1352 "吐纳"硬词误栏**是否应豁免非修炼语境。
8. **ch1634（38.4 低分上岸）**是否需要人工复核终稿。
9. **`[canon硬词] 口诀`**：ch1682 里"没有再教那些复杂的口诀"暗示曾教，与"仅陈老根练"矛盾，判定口径待定。
10. **V05/V06 的卷级概念规划缺失**：`config/leak_terms/concept_unlocks.json` 的 `unlock_schedule` 只有 V01（covered）/V02（planned）/V03（planned）。V05 已补 forbidden 判例、可跑批，但概念解锁时间表仍空；V06 段（1844-2200）将来更会重演"整批挂起"。是否本轮补 V05，或与 V06 判例一起做？
11. **V06 两条 forbidden 未条款化**（守夜人完整身世、门芯脱落细节）：进 V06 前必须先补 R20/R21，否则 `audit_mid_outline` 会像 ch1727 首轮那样把整批挂起。

---

## 9. 关键文件地图

| 用途 | 路径（相对 `...\skills\novel-engine\`） |
|---|---|
| 卷规划 | `src/novel_engine/config/planning/volumes.json` |
| 中纲 | `src/novel_engine/config/planning/mid_outline_*.json` |
| 决策规则 / 伏笔锚点 / 人物注册 | `config/planning/decision_rules.json`、`foreshadow_anchors.json`、`character_registry.json` |
| bible | `src/novel_engine/bible/author_intent.md`、`character_bible.md`、`style_bible.md`、`world_bible.md`、`ending_bible.md`、`decision_rules.md` |
| 运行时状态 | `src/novel_engine/runtime/checkpoint.json`、`state_machine.json`、`state.db`、`fact_changes.jsonl`、`timeline_anchors.json` |
| 成稿 | `src/novel_engine/chapters/novel/`、`draft/`、`draft/failed/` |
| 批次入口 | `src/novel_engine/scripts/run_volume.py` |
| 中纲工具 | `src/novel_engine/scripts/generate_mid_outline.py`、`audit_mid_outline.py`、`concept_audit.py`、`gen_task_cards.py` |
| 质量门 | `src/novel_engine/quality/`（`cross_scene_crisis_gate.py` 等） |
| 编排/提交 | `src/novel_engine/pipeline/pipeline_orchestrator.py`、`core/checkpoint.py` |
| 另一条入口（勿混用） | `src/novel_engine/pipeline/production_runner.py`（位置参数 `num_chapters/start_from/resume_checkpoint` + `--real`，resume 语义与 run_volume 不同） |
| 控制脚本 | `scripts/control/*.bat`（封装 production_runner；`start.bat` 会**重置运行时**，接手时最易踩的坑） |
| 模型配置 | `src/novel_engine/config/llm_providers.json`、`config/runtime_config.json` |
| 权威日志 | `docs/superpowers/quality-backlog.md` |

---

## 10. 已知坑（都是真实踩过的）

1. **COMMITTED ≠ 进 novel/**。看分数和 note，别只看数量。
2. **`runbook.md` / `USAGE.md` / `SKILL.md` 旧目录树**会误导：模型早已不是 SiliconFlow Qwen，测试也不是 16 passed，发布也不是"200 章阶段出口"。
3. **`start.bat` 会重置运行时**（等同 clean），长跑续跑只能用 `run_volume --resume` 或 `resume.bat` 系。
4. **`production_runner` 与 `run_volume` 两套 resume 语义不同**，混用会重复生成或跳过章。
5. **共用工作区**：批次运行中切代码不生效（已 import 旧模块）；改完必须新进程。
6. **`generate_mid_outline` 的环境变量名与主流程不一致**（见 5.2）。
7. **`audit_mid_outline auto` 只审排序第一的文件**，不是全量。
8. **checkpoint 与 draft 有历史不一致**（33 章无 draft、1 章无 checkpoint），resume 以 checkpoint 为准，不用手动"修数据"。
9. **`ch370` 永久跳过**，别当失败重试。
10. **`config/planning` 文件名前缀 V0x 不可信**，按章号判断。
11. **PowerShell 单行裸字符串会被当命令执行**：`Set-Location x; "文字"` 会报错，用 `Write-Output`。
12. **写文件编码**：人看的 md 用 UTF-8；`.bat/.cmd` 必须 CRLF。

---

## 11. 接手自检清单

- [ ] `git log -1 --oneline` 是最新提交，`git status` 干净（本轮 V05 判例改动若未提交，先看第 6 节门禁口径）
- [ ] `run_1726` 是否还在跑（PID 24492 / 日志尾部；00:30 在 ch1716）
- [ ] `checkpoint.last_complete` 当前值（00:30 是 1715，跑完应为 1726）
- [ ] `config/planning/mid_outline_V05_ch1727-1756.json` 存在且 30 条 approved、`meta.status=approved`
- [ ] 下一批命令的工作目录是 `...\src`、`-X utf8`、`--resume`、目标章号 1756
- [ ] 记住 A 路线 #8、git 纪律、cron 不改动、密钥只走环境变量

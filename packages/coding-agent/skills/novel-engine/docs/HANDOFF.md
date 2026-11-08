# PANE 交接说明（HANDOFF）

> 给"下一个接手 agent"的唯一现状入口。历史操作细节在 `docs/superpowers/quality-backlog.md`（条目置顶、按日期倒序），本文件只写**现在是什么状态、接下来做什么、别踩什么坑**。
>
> 最后更新：2026-11-08 22:40 +0800（**按用户指令已停止全部生成进程**；第 3 节是停止瞬间的现场快照，本次改写已提交并推送，提交链见第 1 节）。恢复运行前先按第 5 节第 1 步核对进程。

---

## 0. 一句话现状

3800 章规划，中纲已铺到 **ch1786**（V05 两片：ch1727-1756、ch1757-1786，均 30/30 `approved`）。实际成稿做到 **ch1756 全部收口**，正在推进 ch1757 起的下一批时被用户指令停止：**ch1757 判 FAILED（60.4，三评极差>15），ch1758 生成到一半被终止，ch1759-1786 未开始**。停止后**没有任何生成进程或看护进程在跑**（2026-11-08 22:24 核实）。工作区干净，HEAD `6323508c1`，远端同步。

两批实测：ch1682-1726 共 32 章 → 30 COMMITTED / 2 FAILED（ch1709、ch1724），**均分 67.2**；ch1727-1756 共 31 章（含 1709/1724 重试）→ **全 COMMITTED，均分 70.7**。发布线 88，绝大多数是 force-best 落 draft。

---

## 1. 项目与运行环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine` |
| 分支 | `feat/stability-quality`（远端 `origin` 同名分支，已 push，ahead=0） |
| 最近提交 | 2026-11-08 22:30-22:40 两笔纯文档提交：`b1256174a`（交接文件按停止现场重写）→ 其后的"页首补提交号"一笔（HEAD）。再往前：`6323508c1 feat: 新增 V05 中纲 ch1757-1786（30/30 approved）`、`779c937a7`、`597e56eb8`、`92ae0273f`（文档）、`0dfa88278`（status_snapshot）、`6091d834c`（R18/R19 判例 + 否定语境窗口） |
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
- **重要（历史事实）**：`run_1726` 那一批是 22:08 启动的，Python 已 import 旧模块，该修复**对那一批不生效**，只有新起的进程才用新逻辑。ch1682 在那批以 62.3 上岸，是重生成正文本身不再含触发句，不是修复生效。

---

## 3. 当前进度（实测数字，2026-11-08 22:02 快照 / 22:24 停止复核）

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

`config/planning/mid_outline_*.json` 共 **59 个分片**（每片 30 章，个别早期片 26 章）：

- V01：ch21-316，10 片（**ch1-20 没有中纲**，早期章靠 plot_graph，属正常）
- V02 标签：ch317-706，13 片
- V03 标签：ch707-1726，34 片
- **V05：ch1727-1756、ch1757-1786，2 片**（`mid_outline_V05_ch1727-1756.json`、`mid_outline_V05_ch1757-1786.json`，均 30/30 approved）

**文件名里的 `V0x` 前缀不能当卷依据**：例如 `mid_outline_V03_ch1697-1726.json` 实际落在 V05 的章号段。加载逻辑（`chapter_director._load_mid_outline_entry`）是**扫全目录、按章号匹配 entry**，不看文件名前缀，所以功能上无影响；写新片时请用真实卷号，别再延续错标签。

最新一片 `mid_outline_V05_ch1757-1786.json`：`meta.status=approved`，30 条 entry 全部 `approved`。这一片是 22:04 生成、经两轮修订后过审的（详见 backlog 2026-11-08 第三条）。

门禁规则：`entry.status` 存在时以其为准，只有 `approved` 会被注入 director；`pending_human` / `needs_regenerate` 的章退回"松散参考"（不阻塞批次，但失去强约束）。`entry.status` 缺失的旧文件才看 `meta.status`，`draft` 一律不可用。

**写中纲时的两个真实坑**（本轮踩过）：

- `boundary_note` 里出现"需人工确认"字样 → `audit_mid_outline` 第 439 行直接判 `pending_human`，形成**永久 pending**。要确认的内容请直接写成陈述式结论（如"铺垫：摄魂阁暗探线推进，不揭露组织目的"）。
- `boundary_note` 引用 `f00X` / fid 时，core_event 必须命中该实体的 `anchors`（`config/foreshadow/registry.json`），否则报"锚点未命中，疑似编号标错"。引用前先核对锚点词表。

### 3.3 已完成章与产物

| 指标 | 实测值（2026-11-08 22:02 `status_snapshot.py`，22:24 停止前复核） |
|---|---|
| `runtime/checkpoint.json` | 1780 条 checkpoint（26 条重复章号）、去重后 **1754 个唯一章**、最大 ch1756；22:02 时 `last_complete=1756` |
| `last_complete` 的真实语义 | 它是**最近一次写回的章号**，不是"最大已完成章"。22:15 重试 ch1742 收口后写回 `last_complete=1742`，但 1743-1756 早已 COMMITTED。**判断进度看最大章 + 日志，不要只看这个字段** |
| `failure_counts` | `{"370":13,"867":1,"883":1,"1757":1}`（1757 是 22:21 新增；1709/1724 重试成功后已清零） |
| `skipped_chapters` | `[370]`（永久跳过） |
| `chapters/draft/*.txt` | **1721 个**（编号 6..1756） |
| `chapters/novel/*.txt` | **234 个**（编号 1..1649，很稀疏） |
| `chapters/draft/failed/` | **49 个**章目录 |
| `runtime/state_machine.json` | `current_chapter=1756`、`total_target=3800`、`phase=REVIEW`、`next_state=PASS` |

**查最新状态不用手工盘点**：工作目录 `...\src` 下

```powershell
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.status_snapshot --out "$env:TEMP\_snap.md"
```

只读，不改任何状态；输出 checkpoint/产物/中纲/最近批次均分与最低 5 章/StateDB 行数/下一步命令。

**draft 与 novel 不是一回事，这是最容易误读的地方**：

- `chapters/novel/` 只放**达到发布线（88）**或 gray-band 授权发布的章。
- 88 以下但 hard gate 为空的章，走 `_force_publish_best`：正文落 **`chapters/draft/`**，写一条 `mode=force_best_draft` 的 checkpoint（`core/checkpoint.py:create_draft_checkpoint`，只校验 draft/），`run_volume` 日志里照样打 **COMMITTED**。
- 所以"COMMITTED"= 已提交 checkpoint，**不等于**已进 novel/。
- 本批 32 个 COMMITTED 里，绝大多数是 draft（日志 note 形如 `best 79.5 < 88`）。novel/ 只有 234 章，而 checkpoint 已覆盖 1754 个章号，差距就来自这里。

`runtime/checkpoint.json` 里仍有 26 条重复章号与若干"checkpoint 有、draft 无"的历史章（多为 ch1-100，正文在 novel/ 或已清理）。属历史产物不一致，不是新故障，不影响续跑（resume 以 checkpoint 为准）。

`ch370` 累计 13 次失败后被写入 `skipped_chapters`，**永久跳过**。除非用户明确要求，不要重跑它。

`runtime/state.db`（StateDB，53 KB + 4 MB WAL）：`characters` 8、`factions` 0、`foreshadows` 9、`clue_plans` 20、`relationships` 6、`concept_unlocks` 4。查实时库前先复制一份再查，别在跑批时直连。

### 3.4 两批实测成绩（逐章解析日志 END 行）

| 批次日志 | 窗口 | 落地章数 | 结果 | 均分 | 最低 5 章 |
|---|---|---|---|---|---|
| `runtime/run_volume_20261107T140835Z.log` | ch1682-1726 | 32 | 30 COMMITTED / **2 FAILED**（ch1709、ch1724） | **67.2** | 1720 **34.8**、1699 **42.4**、1716 48.9、1713 52.4、1698 53.2 |
| `runtime/run_volume_20261107T173821Z.log` | ch1727-1756 + 重试 1709/1724 | 31 | **31 全 COMMITTED**（0 FAILED） | **70.7** | 1738 **52.8**、1740 56.3、1750 57.9、1746 59.6、1748 61.9 |

- 第一批 SUMMARY：`30/33 chapters succeeded, 2 failed, 1 skipped in 12487.5s`；第二批：`31/33 succeeded, 1 failed, 1 skipped in 11304.5s`（多出的 failed/skipped 是窗口内非目标章与 ch370）。
- 重试上岸：ch1709 74.3、ch1724 72.5。
- 质量信号与上批持平：42.4/34.8/52.8 这类分数同样以 force-best 落 draft 并被记为 COMMITTED。原因见第 4 节。
- 时间线：第一批 22:08 起跑 → 01:36:58 收在 ch1726；第二批 01:38:20 起 → 04:47:14 抵达 1756，看护按设计退出（`target 1756 reached, watchdog exit`），04:47-22:03 的 17 小时空档**没有进程在跑，不是故障**。

### 3.5 停止瞬间的现场（2026-11-08 22:24，用户指令「停止一切」）

| 项 | 值 |
|---|---|
| 生成进程 | PID **17532**，`python.exe` `-X utf8 -m novel_engine.scripts.run_volume --chapters 1786 --resume`，**已 terminate** |
| 看护进程 | PID **31144**，`pythonw.exe %TEMP%\_relay_novel.py`（TARGET=1786），**已 terminate** |
| 残留 | 复核 `remaining_count 0`：没有任何 `run_volume` / `relay_novel` 进程 |
| 停在哪一章 | 22:21:31 ch1757 **FAILED**（score 60.4，`三评极差>15，强制人工复核（不自动重采）`）；同一秒进 ch1758，场景 1/2/3 长度不足重生成，22:24 被终止 |
| 本轮新增 checkpoint | ch1742 重试收口：`COMMITTED`，force-best **55.0**、488.6s，note 记 `plot_consistency/high:关键道具矛盾`、`foreshadow_execution/medium:F001 密使袖口纹样未落正文`；日志另有 `CHAPTER 1742 NEEDS HUMAN: directing_error`（任务卡场景 3/4 写成「次日午后/次日黄昏」越过章级「跨夜」跨度） |
| failure_counts | `{"370":13,"867":1,"883":1,"1757":1}`（1742 本次已成功，不再计数） |
| 包装日志 | `%TEMP%\run_1786_batch.log`（+0800 时间戳）；运行时日志 `runtime/run_volume_<时间戳>.log` |
| 停止前取证 | `%TEMP%\_pre_stop.txt`（日志尾 + checkpoint + 进程表）、`%TEMP%\_stop_all.txt`（terminate 结果） |

**恢复运行的唯一命令**（工作目录 `...\skills\novel-engine\src`，目标先设 1786，不要改小）：

```powershell
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.run_volume --chapters 1786 --resume
```

- `--resume` 会跳过已 COMMITTED 章。**ch1758 的残稿会在重启后被当作未完成而重做**，不会半截入档；ch1757 会在 failure_counts=1 的情况下重试，第 5 次才触发跳过阈值。
- 不要再起第二个批次：`checkpoint.json`、`state.db`、`chapters/` 是共用状态。
- 看护脚本 `%TEMP%\_relay_novel.py` 仍在（未入库），常量已改成 `TARGET=1786`、`OUT=run_relay_1786.log`；要用就重新 `pythonw` 起，它会先检测是否已有 `run_volume` 进程。

---

## 4. 质量判定规则（按代码真实行为写，不是按文档）

配置在 `config/runtime_config.json` 的 `quality` 段：`pass_threshold=88`、`fix_threshold=60`、`publication_line=88`、`min_chapter_score=60`、`min_pacing=7.5`、`min_innovation=7.0`、`target_avg_score=88`。

`pipeline/pipeline_orchestrator.py` 收尾分支（约 986-1031 行）的实际行为：

1. **best ≥ 发布线，且 hard gate 全过** → `success=True`，`apply_world_state=True`，发布 `chapters/novel/`。
2. **best ≥ 发布线，但 hard gate 仍阻断** → `force publish`：`success=True`，附 note，标人工复核，发布路径受 `_force_publish_best` 控制。
3. **best < 发布线，且不在 gray-band** → **force-best 到 draft**：`success=True`、`published=True`、`apply_world_state=False`，note 形如 `best 42.4 < 88 (hard gate [])`，同时 `_flag_for_human`。**这是 88 以下也能"上岸"的机制来源，不是 bug，是现行设计（给人工审阅用）**。
4. **gray-band**：`soft_publication_line = min_ch - 3`，落在 [soft, 88) 且无 high issue、det 通过 → 授权发布 novel/ 并标"抽读复核"（ch62 那类问题的产物）。
5. **评审极不稳定**：两次评审极差 >15 → 直接 FAILED，强制人工复核，不自动重采（ch1709 那次是，重试后 74.3 上岸；ch1757 本次也是，60.4）。
6. 82-87 分另有一条"人工复核队列"路径（落 draft + `pending_human_review`），与 force-best 并列。

推论：**看 `run_volume` 日志的 COMMITTED 数量不能判断质量，必须看分数和 note**。均分 67.2 / 70.7 而 checkpoint 一路涨，是这套兜底的正常表现，也是当前最大隐患。

---

## 5. 接手后的执行顺序

### 第 1 步：确认当前无进程（**已满足**，2026-11-08 22:24 核实）

- 现在是"全停"状态：生成 PID 17532、看护 PID 31144 均已 terminate，`remaining_count 0`。重新开跑前先确认这一点，别和残留进程抢状态。
- 核对方式：`Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='pythonw.exe'"`，筛命令行含 `run_volume` / `relay_novel` 的项，应为空。
- **不要**同时跑两个批次：`runtime/checkpoint.json`、`state.db`、`chapters/` 是共用状态，会互相覆盖。

### 第 2 步：中纲 ch1727-1756 / ch1757-1786 —— **两片均已完成并入库**

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

**ch1757-1786 这一片的实际处置**（2026-11-08 22:04-22:14，最容易踩坑的一片）：

1. 首轮生成只得 **29 条，缺 ch1777**（日志 `batch missing chapters: [1777]`）→ 用 `--only 1777 --out <同一文件>` 合并补齐到 30。
2. 首轮 audit：20 approved / **8 pending_human** / **2 needs_regenerate**。pending 全部因为 `boundary_note` 写成"需人工确认：…"（`audit_mid_outline.py` 第 439 行永久判 pending）。`needs_regenerate` 两章：**ch1757** 撞 A 路线（"陆烬体内气机运转"）、**ch1784** 撞"呼吸"概念锁。
3. 改 10 条措辞：ch1757 → "陈老根在村后古树下练习改良版呼吸法，陆烬在旁只是安静看着，记下他起手收势的次序"；ch1784 → "陈老根独自习练基础呼吸法残篇，陆烬在旁看着，没有跟着动手"；8 条 pending 的 boundary_note 全部改成陈述式"铺垫：…"。
4. 第二轮：27 approved / 3 pending，全是**伏笔锚点未命中**——ch1761 引 `f001_royal_heirlooms`（core_event 无"残物/残片/残卷"）、ch1775 引 `f002_hunyuan_scripture`（无"养魂经/呼吸法"）、ch1779 引 `f004_mitochondria_earth`（实为迷雾场景，正确 fid 是 **f005_fog_core**）。补丁：ch1761 追加"与几张残卷"、ch1775 把"基础呼吸练习"改"呼吸法残篇"、ch1779 换 f005。
5. 第三轮：**30 approved / 0 pending / 0 needs_regenerate**，`[覆盖审计] V05 forbidden 2/2 已判定化`。随后写 `meta.status=approved` + 逐条 `meta.audit`。

教训：**同一片里"生成缺章 + pending_human + 概念锁 + 锚点错配"会叠加**，一轮很难收敛，按"生成→审计→按类别批量改措辞→重审"迭代，别一次只改一章。

### 第 3 步：启动下一批（**当前处于停止状态，等用户指令**）

停止是用户明确指令（2026-11-08 22:23「停止一切」），不是异常退出。要恢复时手动起一次：

```powershell
Set-Location "D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine\packages\coding-agent\skills\novel-engine\src"
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.run_volume --chapters 1786 --resume
```

- **目标固定 1786**：中纲只铺到 1786，1787 起会退回"松散参考"。到 1786 之前必须先补 ch1787-1816 的中纲（同第 2 步流程），否则等于无约束自由发挥。
- 新进程会 import 最新代码（含 `f38029fc7` 危机门修复、`6091d834c` R18/R19 与否定语境窗口）。批次运行中改代码不生效。
- 看护（可选，`%TEMP%\_relay_novel.py`，常量已改为 `TARGET=1786`、`OUT=run_relay_1786.log`）：每 120s 扫 `novel_engine.scripts.run_volume` 进程，没有且 `last_complete < TARGET` 时自动起 `--chapters TARGET --resume`，到目标或连续 3 次无进展退出。日志 `%TEMP%\relay_novel.log`，每条 `watchdog start target=… pid=…` 就是当前 PID。
- **顺序**：先关看护再关生成，否则看护会立刻补位。关看护 = `Get-Process pythonw` 找到跑 `_relay_novel.py` 的 PID 后 `Stop-Process -Id <pid>`。
- 本次停止用的方式：psutil 先 terminate 子进程再 terminate 自身，15s 不退再 kill；脚本 `%TEMP%\_stop_all.py`，输出 `%TEMP%\_stop_all.txt`，复核 `remaining_count 0`。
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
3. **门禁**：在 `...\skills\novel-engine\src` 下跑
   `python -X utf8 -m pytest novel_engine/tests -q` —— 当前基线 **1302 passed / 1 xfailed / 3 warnings，约 193s**；再跑 `python -X utf8 -m pyflakes novel_engine` —— 约 247 行告警但**必须 0 处 undefined name**，且**禁止截断输出**（`Select-Object -First` 会漏检，历史上漏过真实 bug）。只跑局部门禁不足以放行。
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
| ~~没有"当前状态快照"文件~~ | 已补：`scripts/status_snapshot.py`（只读，输出 Markdown；22:02 那版见第 3.3 节） | 每批收敛后跑一次，必要时贴进第 3 节 |
| 没有"质量趋势"记录（各批均分、低于 60 章走势） | 看不到"越跑越差"还是"偶发" | 从 `run_volume_*.log` 的 END 行做一个小脚本，产出 `audit/batch_quality.csv` |
| `needs_human_review.json` 队列没人消费 | 低分 draft 越积越多（本轮新增 ch1742 55.0、ch1757 60.4） | 先定"谁审、按什么顺序审、审完怎么回写" |
| `docs/runbook.md` 正文 | 会把人带到 SiliconFlow/Qwen、16 passed、200 章出口的旧世界 | 需要一次整体重写（下一项独立任务） |
| 中纲 `V0x` 标签与真实卷号错位 | 人类阅读时容易误判进度 | 新片用真实卷号；历史片不批量改名（改名会动 git 历史且无功能收益） |
| `chapters/outline/` 只有 39 个 task_card 快照 | 无法复盘"当时按什么卡写的" | 如需复盘再补，非阻塞 |
| 批次成绩统计脚本未入库（本轮用 `%TEMP%\_stat_batches.py` 解析 END 行） | 换机/换人无法复现"均分、最低 5 章"的口径 | 收编进 `scripts/`，或并入 `status_snapshot` 输出 |

---

## 8. 待决事项（需要用户拍板，别自行决定）

1. **要不要重启批次**（当前第一决策点）：现在全停，成稿收在 ch1756（1757 FAILED、1758 半截），中纲到 1786。重启命令见 3.5；不重启就一直停着。
2. **均分 67.2 / 70.7 怎么处理**：继续按这个口径往下推（接受绝大多数章以 draft 形态存在），还是先停下来做质量治理？
3. **低于 60 分的章是否补写**：ch1720(34.8)、ch1699(42.4)、ch1716(48.9)、ch1713(52.4)、ch1738(52.8)、ch1742(55.0)、ch1740(56.3)、ch1750(57.9) 都在 draft，未进 novel。ch1709 已重试上岸 74.3，不需再议。
   - **ch1757 人工复核**：60.4，`三评极差>15，评审极不稳定，强制人工复核（不自动重采）`，已 FAILED 且 failure_counts=1（第 5 次才进跳过）。重启批次会自动重试，但同一根因大概率复现。
   - **ch1742 人工复核**：本次 force-best **55.0** 放行，但正文明细有两处硬伤——`plot_consistency/high` 关键道具信息矛盾、`foreshadow_execution/medium` F001 密使袖口纹样未落入正文；任务卡还把场景写成「次日午后/次日黄昏」越出章级「跨夜」跨度（`NEEDS HUMAN: directing_error`）。
4. **writer 输出退化**（短篇、分词碎裂成单字行、复读"尸位素餐"十余次）：ch1682 原始稿的 15.5 分主因，尚无归因与修复方案。是否作为下一项机制任务？
5. **dim-gate 长度严重不足**（`[长度] 5078 < 7310`）：ch1688、ch1698 都出现过，属系统性问题，是否改 dim-gate 策略或人工补写？
6. **`稳固神魂` 类防御性调息**是否算 A 路线 #8 禁项（当前从严处理）。
7. **ch1352 "吐纳"硬词误栏**是否应豁免非修炼语境。
8. **ch1634（38.4 低分上岸）**是否需要人工复核终稿。
9. **`[canon硬词] 口诀`**：ch1682 里"没有再教那些复杂的口诀"暗示曾教，与"仅陈老根练"矛盾，判定口径待定。
10. **V05/V06 的卷级概念规划缺失**：`config/leak_terms/concept_unlocks.json` 的 `unlock_schedule` 只有 V01（covered）/V02（planned）/V03（planned）。V05 已补 forbidden 判例、可跑批，但概念解锁时间表仍空；V06 段（1844-2200）将来更会重演"整批挂起"。是否本轮补 V05，或与 V06 判例一起做？
11. **V06 两条 forbidden 未条款化**（守夜人完整身世、门芯脱落细节）：进 V06 前必须先补 R20/R21，否则 `audit_mid_outline` 会像 ch1727 首轮那样把整批挂起。
12. **ch1787-1816 中纲未生成**：现有中纲止于 1786，续跑必须先在跑到 1786 之前补这一片，否则 1787 起退回松散参考。

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
6. **`generate_mid_outline` 的环境变量名与主流程不一致**（见第 2 步）。
7. **`audit_mid_outline auto` 只审排序第一的文件**，不是全量。
8. **checkpoint 与 draft 有历史不一致**（26 条重复章号、若干老章无 draft），resume 以 checkpoint 为准，不用手动"修数据"。
9. **`ch370` 永久跳过**，别当失败重试。
10. **`config/planning` 文件名前缀 V0x 不可信**，按章号判断。
11. **PowerShell 单行裸字符串会被当命令执行**：`Set-Location x; "文字"` 会报错，用 `Write-Output`。
12. **写文件编码**：人看的 md 用 UTF-8；`.bat/.cmd` 必须 CRLF。
13. **`checkpoint.last_complete` 不是最大已完成章**：重试老章后会被写回那个小章号（22:15 重试 ch1742 后变成 1742，而 1743-1756 早已完成）。判断进度看 checkpoint 里的最大章、`chapters/draft` 最大编号和日志 END 行。
14. **看护必须先于生成关停**：直接杀掉 `run_volume` 而不关 `_relay_novel.py`，看护会在 120s 内自动补起一个新批次。

---

## 11. 接手自检清单

- [ ] `git log -1 --oneline` 是 `b1256174a`（或之后的提交），`git status` 干净
- [ ] **确认没有任何进程在跑**：`Get-CimInstance Win32_Process` 筛 `run_volume` / `relay_novel` 应为空；本次停止后 `remaining_count 0`
- [ ] `checkpoint.json`：最大章 1756、`failure_counts` 含 `1757:1`、`skipped=[370]`；`last_complete` 若显示 1742，那是重试写回，不是进度（见 10.13）
- [ ] `chapters/draft` 最大编号 1756、共约 1721 个；`chapters/novel` 234 个（到 1649）
- [ ] `config/planning/mid_outline_V05_ch1727-1756.json` 与 `mid_outline_V05_ch1757-1786.json` 均 30 条 approved、`meta.status=approved`
- [ ] 要重启：工作目录 `...\src`、`-X utf8`、`--resume`、**目标 1786**；先起生成还是先起看护要想清楚（见第 3 步与 10.14）
- [ ] 跑过 1786 之前先补 ch1787-1816 中纲，否则退回松散参考
- [ ] 记住 A 路线 #8、git 纪律、cron 不改动、密钥只走环境变量

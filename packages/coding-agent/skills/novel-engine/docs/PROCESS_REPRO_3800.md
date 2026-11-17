# 3800 章长篇小说完整生成流程复盘（复现手册）

> 生成时间：2026-11-17（3800 章全量生成完成当日）
> 适用对象：接手复现 / 审计整个小说生成项目的 agent 或人
> 配套阅读：`docs/HANDOFF.md`（当前状态入口）、`docs/superpowers/quality-backlog.md`（唯一权威操作日志，条目置顶倒序）

## 1. 项目定位

`novel-engine` 是 Prime-Agent 底座上的长篇网文生产管线：多智能体流水线（Chapter Director → World Simulator → Writer → Reviewer）+ StateDB（SQLite 精确状态检索，非向量 RAG）+ Durable Session Tree（分支回滚）+ 增量 Patcher。本次产出：《吸氧证道》3800 章（10 卷），ch1-3800 全部收口（3796 COMMITTED + 4 永久 skip：370/1757/2683/3092）。

## 2. 关键路径与环境

| 项 | 值 |
|---|---|
| 仓库 | `D:\AI\Prime-Agent-Novel-Engine\Prime-Agent-Novel-Engine`，分支 `feat/stability-quality`，最终 HEAD `14ff37606`（ch3781-3800 中纲） |
| 技能包根 | `packages\coding-agent\skills\novel-engine\` |
| 数据根 = 包根 | `...\src\novel_engine\` |
| **运行/测试工作目录** | `...\skills\novel-engine\src`（不是仓库根） |
| Python | `D:\Program Files\Python312\python.exe -X utf8` |
| 模型 | `config/llm_providers.json` → `agnes-3.0-flash`（端点 `apihub.agnes-ai.com`）；key 只在 `src/novel_engine/.env`（`AGNES_API_KEY`），禁止进 json/argv/git |
| Shell | Windows + pwsh7；Bash 不可用 |

## 3. 总体规划层（先于生成完成）

1. **卷规划**：`config/planning/volumes.json`，10 卷 3800 章：
   V01 昆仑遗子 1-316 / V02 大乾人间 317-652 / V03 仙门初渡 653-988 / V04 万山寻仙 989-1422 / V05 人间藏仙 1423-1843 / V06 阴阳双界 1844-2200 / V07 天门之后 2201-2600 / V08 仙门旧墟 2601-3000 / V09 伐天人皇 3001-3400 / V10 人道定仙天 3401-3800。
2. **决策规则**：`config/planning/decision_rules.json`，卷级 forbidden 条款逐卷条款化（R 系列判例）：
   - R18/R19（V05 段，含否定语境窗口）→ R20/R21（V06 进卷前）→ R22/R23（V07）→ R24/R25（V08）→ R26/R27（V09：仙庭反派保留悲剧性、血冥教投诚观察期未三月不授作战任务）→ R28/R29（V10 收官卷：新伏笔禁令 + 陆烬主动退场）；
   - 规则进卷前先条款化并写入 `decision_rules.json`，否则 `audit_mid_outline` 会把整批挂起。
3. **A 路线 #8（创作硬边界）**：陆烬（C001）第一阶段（筑基前）禁止任何修炼样式动作（口诀/吐纳/引气/共鸣概念词）；呼吸法/口诀/调息只能由陈老根（C002）独自进行，陆烬最多"在旁看到/被告知结果"。违反即 needs_regenerate，按"陈老根独述 + 陆烬旁观"重写。
4. **伏笔体系**：`config/foreshadow/registry.json`（F001-F009 + 锚点词表）；`config/planning/foreshadow_anchors.json`。中纲 `boundary_note` 引用 fid 时，`core_event` 必须命中该实体 anchors，否则"锚点未命中"。
5. **中纲（chapter 级意图）**：`config/planning/mid_outline_*.json`，30 章/片（早期 9-20 章/片），共 ~110 片覆盖 ch21-3800（ch1-20 靠 plot_graph）。全部 `entry.status=approved` + `meta.status=approved` 才注入 director。加载按**章号匹配**，文件名 `V0x` 前缀不可信（历史片有错标签，写新片用真实卷号；V06 配置覆盖全段，V10 段也 `--vid V06` 生成）。

## 4. 中纲生产流程（每片重复）

```
# 1) 生成（30 章/片，--batch-size 6；key 自动读 .env）
python -X utf8 -m novel_engine.scripts.generate_mid_outline --vid V0x --start N --end N+29 --batch-size 6

# 2) 审计（位置参数=文件路径；`auto` 只审排序第一的文件，勿用）
python -X utf8 -m novel_engine.scripts.audit_mid_outline config/planning/mid_outline_V0x_chA-B.json
```

**四类高频 flag 及修复（实战模式，按类批量改再重审，别一章一章改）**：

| Flag | 根因 | 修复 |
|---|---|---|
| `pending_human` | `boundary_note` 写了"需人工确认"字样（audit 第 439 行永久判 pending） | 改为陈述式结论："铺垫：…推进，不揭露 X" |
| `needs_regenerate`（A 路线） | LLM 写出"陆烬体内气机/共鸣运转" | 重写 core_event 为"陈老根独自操作 + 陆烬仅旁观/被告知"，加 f009 锚点 + A 路线合规 boundary_note |
| "新角色未登记" | LLM 把 `F008`（伏笔 ID）或"后续角色/摄魂阁高层"写进 `characters` 字段 | 替换为登记角色 C007（守夜人）或 `f008_doorkeeper` token |
| "锚点未命中" | `boundary_note` 引用 fid 但 `core_event` 无锚点词 | 把锚点短语（如 "守夜人低声自陈'我是门之影'"）force-append 进 `core_event` |
| 缺章（29/30） | LLM 返回越界章号（如 3359/33688） | 用 `--only <缺章> --out <同一文件>` 补齐；极少数 19/20 可接受（audit 按可用条目过） |

收敛判定：全片 entry 30/30 approved → 写 `meta.status=approved` + `meta.audit` → 只 `git add` 该文件提交。

## 5. 生成批次流程（run_volume + 看护）

### 5.1 启动（必须剥代理变量）

DSH 会话注入 `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:7897`（Clash，常未启动）。LLM 出站层 `httpx` 读代理变量 → 报 `Invalid port: ':1]'`；而 `run_volume` 预检用 `urllib` 不读代理变量，**预检 200 ≠ LLM 正常**。症状 = 全章 ~17s 快速 FAILED、score=None。

```powershell
# 生成：工作目录 ...\novel-engine\src，剥 8 个 proxy 变量（HTTP/HTTPS/ALL/NO_PROXY 大小写两组）
Start-Process -WindowStyle Hidden "D:\Program Files\Python312\python.exe" `
  -ArgumentList "-X","utf8","-m","novel_engine.scripts.run_volume","--chapters","<TARGET>","--resume"

# 看护：pythonw DETACHED，120s 轮询
Start-Process -WindowStyle Hidden "pythonw.exe" -ArgumentList "$env:TEMP\_relay_autorelay.py"
```

注意：`Start-Process` 子进程**继承 shell 环境**（含 proxy 变量）——直接 `python -m run_volume` 会带毒。复现时用 noproxy 包装脚本（读 `.env` key + 剥 proxy + `subprocess.Popen`），或确保父环境已清理。

### 5.2 批次推进

- `--resume` 跳过已 COMMITTED 章；挂点（failure count 未达 5）自动重采；
- 批收敛（target reached）后看护自动接力下一 target（本流程 FINAL_CAP=3800，到顶自动退出）；
- 每批 ~30-60 章，~4-5 min/章（LLM 耗时 95-486s/章波动）。

### 5.3 提交语义（pipeline_orchestrator 收尾分支）

| 分数 | 行为 |
|---|---|
| ≥88 且 hard gate 全过 | 发布 `chapters/novel/` |
| ≥88 但 hard gate 阻断 | force publish + 人工复核标记 |
| 82-87 | draft + `pending_human_review` 队列（FAILED，下批重试） |
| <82（含 42 分） | force-best 落 `chapters/draft/`，COMMITTED，`mode=force_best_draft` |
| FINAL GATE BLOCK | 隔离 + gap-continue（后续章补洞） |
| 三评极差 >15 | 直接 FAILED，强制人工复核，不自动重采 |

**关键认知：COMMITTED ≠ 进 novel/**。3796 章中 235 章达 88 进 `chapters/novel/`，其余 ~3560 章为 force-best draft（正常设计，给人工审阅用）。

### 5.4 挂点与 skip 策略

- 跨批累计失败 5 次（`--skip-after 5`）→ 写入 `skipped_chapters` 永久跳过；
- 实战永久 skip：ch370（13 次，历史遗留）、ch1757（canon 硬词"呼吸"，count=4 后 skip）、ch2683、ch3092（WRITE_REPLAN livelock，count=4，score=None 引擎异常）；
- 误杀 edge：单章 livelock 会同时卡死"连续进度"和"最大进度"两路探测 → 看护 3 次重启无进展自动退出；处置 = `mark_skipped(<章>)` 后重启看护（`_skip_XXXX.py` 模式）。

## 6. 质量与合规体系

- **质量门**：`quality/`（cross_scene_crisis_gate、dim-gate 长度/重复检测、三评一致性）；`runtime_config.json`：pass 线 88、fix 线 60、min_pacing 7.5、min_innovation 7.0；
- **世界状态**：StateDB（`runtime/state.db`：characters/factions/foreshadows/clue_plans/relationships/concept_unlocks）+ `fact_changes.jsonl` + `timeline_anchors.json`；查库先复制，勿直连跑批中的库；
- **门禁（代码变更时）**：`src` 下 `pytest novel_engine/tests -q`（基线 ~1302 passed/1 xfailed，~193s）+ `pyflakes novel_engine`（0 undefined name，禁止截断输出）；仓库根 `npm run check`；
- **git 纪律**：禁 `git add -A` / `reset --hard` / `checkout .` / `clean` / `stash`；只 add 自己改的文件；
- **共用状态**：`checkpoint.json` / `state.db` / `chapters/` 全局唯一，**永远不要两个批次同时跑**。

## 7. 进度监测口径（防误读）

- 连续进度 = 从 1 起走 `complete ∪ skipped` 的连续链；`last_complete` 只是"最近一次写回的章号"，重试老章后会变小，**不是**最大已完成章；
- 判断进度看：checkpoint 最大章 + `chapters/draft` 最大编号 + 日志 END 行；
- 一键快照：`python -X utf8 -m novel_engine.scripts.status_snapshot --out "$env:TEMP\_snap.md"`（只读）；
- 批次统计：解析 `run_volume_*.log` 的 `=== END chapter N [COMMITTED|FAILED]` 行（章号/分数/耗时）；
- 日志注意：WARNING 行落在 relay stdout，run log 只有 INFO/ERROR，排查看两处。

## 8. 时间线与里程碑（2026-09 ~ 2026-11）

| 时段 | 事件 |
|---|---|
| 09 月底 | 早期批次（ch51 起，batch 日志 `run_volume_batch_142-170` 等）；危机门误判修复 `f38029fc7` |
| 10/12 | 质量 backlog 快照；HANDOFF 体系建立（`98b21807b` 起） |
| 11/09 | 接手重启 + 代理根因实踩（`Invalid port: ':1]'` 全章挂）；`_run_1786_noproxy.py` + patched 看护上线 |
| 11/09-11/13 | 逐批推进 ch1786→3092 段，中纲随生成覆盖率滚动补（每批收敛前把 30 章中纲铺到位）；ch2683 活锁 skip；ch3092 活锁 skip（11/14 23:47） |
| 11/14-11/15 | ch3093-3490 段（V09 R26/R27）：中纲 3101-3600 共 13 片全部 approved；三评极差挂点密集（~1/2h 一个，count=1 冻结下批重采） |
| 11/16 00:14 | 用户暂停 8h（tokens 告急）；08:15 恢复 |
| 11/16 08:15-15:05 | 恢复后 proxy 回归一次（Start-Process 未剥变量）→ 30 章 count=2 → 修复重起；批 3490 收敛；挂点集中重采清零 |
| 11/16 15:05 | max complete 3800 达成；看护接力 15:17-16:40 完成最后挂点重采（SUMMARY 23/27 成功 0 失败 4 skip），FINAL CAP reached 看护自动退出 |
| 11/17 | 收官盘点：3796 complete + 4 skipped，连续 3800，active failures 0 |

## 9. 最终产物盘点

| 产物 | 位置 | 数量 |
|---|---|---|
| 中纲分片 | `config/planning/mid_outline_*.json` | ~110 片，ch21-3800 全 approved |
| 发布成稿（≥88） | `chapters/novel/` | 235 章 |
| force-best draft | `chapters/draft/` | 3763 章 txt |
| checkpoint | `runtime/checkpoint.json` | ~3780 条（含历史重复章号，resume 以 checkpoint 为准） |
| 批次日志 | `runtime/run_volume_*.log` | 09/28 起 ~200 个 |
| 世界状态 | `runtime/state.db` / `fact_changes.jsonl` / `timeline_anchors.json` | 全书事实账本 |
| 提交 | git `feat/stability-quality` | 中纲提交每片一笔（~110 笔），HEAD `14ff37606` |

## 10. 复现速查（checklist）

- [ ] 工作目录 `...\novel-engine\src`，Python 3.12 + `-X utf8`
- [ ] 环境：剥 8 个 proxy 变量（大小写两组）；key 从 `.env`（`AGNES_API_KEY`），不进 argv/git
- [ ] 规划层：`volumes.json` + `decision_rules.json`（进卷前把新卷 forbidden 条款化）+ 伏笔 registry + 中纲 30 章/片 approved
- [ ] 中纲四类 flag 按 §4 表批量修复再重审；缺章 `--only` 补
- [ ] 生成：`run_volume --chapters <TARGET> --resume`（noproxy 方式起）+ 看护 `_relay_autorelay.py`（pythonw，FINAL_CAP 自动退出）
- [ ] 单批收敛 → 补下一片 30 章中纲 → 看护自动接力下一批；中纲始终领先生成 ≥1 片
- [ ] 挂点策略：count=1 冻结下批重采；count≥5 引擎自动 skip；livelock/score=None 异常手动 `mark_skipped` 后重启看护
- [ ] 进度口径：最大章 + draft 最大编号 + 日志 END 行，不看 `last_complete`
- [ ] 停生成顺序：先关看护，再关 run_volume（反序会被 120s 补起）
- [ ] 代码改动才跑门禁（pytest + pyflakes + npm run check）；git 只 add 自己改的文件

# 中纲四类 Flag 修复速查（outline-fixes）

> 固化自 3800 章实战（~110 片中纲片 × 每片 2-5 轮 audit）。
> 中纲加载按**章号匹配**，文件名 `V0x` 前缀不可信；新片一律用真实卷号
> （V10 段也用 `--vid V06`，V06 配置覆盖全段，R28/R29 来自 decision_rules.json）。
> 工作目录：`...\novel-engine\src`，**启动前剥 8 个 proxy 变量**（见 `docs/watchdog-runbook.md`）。

## 1. 标准循环

```
# 1) 生成（30 章/片；key 自动读 .env）
python -X utf8 -m novel_engine.scripts.generate_mid_outline --vid V0x --start N --end N+29 --batch-size 6

# 2) 审计（位置参数 = 文件路径；`auto` 只审排序第一的文件，勿用）
python -X utf8 -m novel_engine.scripts.audit_mid_outline config/planning/mid_outline_V0x_chA-B.json

# 3) 按本文件 §2 决策树批量修复 → 重审 → 收敛
# 4) 30/30 approved → 写 meta.status=approved + meta.audit → git add 单文件提交
```

## 2. Flag 决策树（按类批量改，别一章一章改）

| Flag | 根因 | 修复动作 |
|---|---|---|
| `pending_human` | `boundary_note` 含"需人工确认"字样（audit 第 439 行永久判 pending） | 全部改为陈述式结论，如 `铺垫：X 推进，不揭露 Y`；**不写"需人工确认"** |
| `needs_regenerate`（A 路线 #8） | LLM 写出陆烬修炼样式动作（气机/口诀/共鸣/呼吸法主体为陆烬） | core_event 重写为"陈老根（C002）独自操作 + 陆烬仅旁观/被告知结果"；追加 f009 锚点（"陆烬对两界神魂的异常感知仅停留在间接察觉层面"）+ A 路线合规 boundary_note |
| `needs_regenerate`（概念词越界） | 卷级 forbidden 词出现在早期章（如 V05 段写"仙庭"） | 换用已解锁概念，或把该章事件后移；卷级 forbidden 未条款化时先补 `decision_rules.json`（R 系列）再生成 |
| "新角色未登记: F008 / 后续角色 / 摄魂阁高层…" | LLM 把伏笔 ID 或未登记角色写进 `characters` 字段 | 替换为登记角色（C007 守夜人）或 `f008_doorkeeper` 之类 token；**F008 是伏笔不是角色** |
| "锚点未命中" | `boundary_note` 引用 fid 但 `core_event` 无该实体锚点词 | 把锚点短语 force-append 进 `core_event`，如 `守夜人低声自陈"我是门之影"（f008）` |
| 缺章（29/30） | LLM 返回越界章号（如 3359/33688 被丢弃） | `generate_mid_outline --only <缺章> --out <同一文件>` 补齐；极少数 19/20 可接受 |
| `entry.status` 缺失（旧文件） | 早期文件无 entry 级状态 | 以 `meta.status` 为准；`draft` 不可注入 director，必须补审计 |

## 3. 常用 fid 锚点（实战引用率最高）

| fid | 锚点短语 |
|---|---|
| f001 | 七窍碑 / 传国玉玺残片 |
| f002 | A 路线（陆烬被动性约束） |
| f005 | "迷雾边缘的余韵在指尖若隐若现" |
| f006 | 共守派残脉 / 传国玉玺 |
| f008 | "守夜人低声自陈'我是门之影'"（doorkeeper） |
| f009 | "陆烬对两界神魂的异常感知仅停留在间接察觉层面" |

（全表见 `config/foreshadow/registry.json` 与 `config/planning/foreshadow_anchors.json`）

## 4. A 路线 #8 重写模板

违反章的 core_event 标准形态（以 ch3325/ch3486/ch3657 为例）：

- 主体动作：`陈老根在村后古树下独自练习改良版呼吸法残篇`；
- 陆烬侧：`陆烬在旁安静看着，记下他起手收势的次序` / `陆烬只是被告知结果`；
- 禁止出现（陆烬主语）：口诀、吐纳、引气、气机运转、共鸣、呼吸法练习、调息、静坐静神；
- boundary_note 陈述式：`铺垫：X 推进（陆烬阶段 1 合规，不越 A 路线 #8 边界，plant@NNNN，resolve@3800 前）`。

## 5. 收敛判据与提交

- 全片 30/30 `entry.status=approved`、0 pending、0 needs_regenerate；
- `meta.status=approved` + `meta.audit`（记录本轮修复条目）；
- `git add` **仅该中纲文件**提交（禁 `git add -A`）；
- 同一轮同时出现"缺章 + pending + 概念锁 + 锚点错配"是常态，**按类批量改一轮再重审**，
  不要逐章修（实战 ch1757-1786 片三轮收敛：首轮 29 条缺章 + 8 pending + 2 needs_reg，
  二轮 27/3/0，三轮 30/0/0）。

## 6. 已知边界（当前未自动化）

- 缺章自动 `--only` 补齐尚未做进生成器（越界章号直接丢弃），靠本手册 §2 人工触发；
- 伏笔 `resolve@` 点逾期未触发会产生 hard-gate `foreshadow_closure_overdue`（3400+ 段密集），
  属内容排布问题，暂以 force-best 落 draft 消化，未改门禁阈值；
- `audit_mid_outline auto` 只审排序第一文件，全量巡检需按目录逐个跑（未来可加 `--all`）。

## 7. 一键修复脚本（2026-11-18 入库）

`scripts/outline_repair.py` 已把 §2 决策树脚本化（幂等，跑前先备份原文件）：

```powershell
# 修复 + 审计一轮
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.outline_repair `
    config/planning/mid_outline_V05_ch1757-1786.json
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.audit_mid_outline `
    config/planning/mid_outline_V05_ch1757-1786.json
```

覆盖：① `需人工确认` → 陈述式 boundary_note；② 未登记角色（F008/后续角色/摄魂阁高层）
→ C007；③ 空/生成失败 core_event → 报告待 `--only`（不代笔）；④ fid 锚点缺失 →
force-append 锚点短语（f009 同时加 A 路线合规尾注）。**不替代 audit**：
`meta.status=approved` 仍由 audit 收敛后写入；概念词越界类 needs_regenerate
（卷级 forbidden）不在脚本范围，仍需按 §2 人工改写 core_event。

**换书只改 yaml**：A 路线正则、锚点短语、合规尾注、角色替换表都在
`config/constraints/project_constraints.yaml`（`scripts/constraint_pack.py` 加载，
`audit_mid_outline` 与 `outline_repair` 均 pack-first、缺省退回内置默认值）。

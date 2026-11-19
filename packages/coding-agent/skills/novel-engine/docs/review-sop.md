# 低分章治理 SOP（draft 积压消费流程）

> 背景：发布线 88 以下走 force-best 落 `chapters/draft/`（COMMITTED 但非发布），
> 全书收官时积压 ~3560 章 draft + `runtime/needs_human_review` 队列无人消费。
> 本 SOP 定义"谁审、什么顺序、审完怎么回写"的最小闭环。
实现脚本：`scripts/review_worklist.py`（自动去重 + 分级 + `--mark-reviewed`
回写 `audit/review_accepted.json`）；本文 P0-P3 分级口径与脚本一致，
`audit/review_worklist.json/.md` 为工作清单唯一来源。

## 1. 队列与优先级（`scripts/review_worklist.py` 自动产出）

| 优先级 | 来源 | 动作 |
|---|---|---|
| P0 | 分 < 60 / 无分（补写候选） | 人工重写或 `run_volume` 定向重采（`--only` 批次） |
| P1 | 60-81 force-best draft（note 含 hard gate：canon 硬词 / 伏笔逾期 / 危机门） | 人工改稿过 gate，或判定 gate 误拦后改门禁 |
| P2 | 82-87 人工复核队列本体 | 逐章过目，接受或改稿 |
| P3 | ≥88 抽读 / 三评极差 >15 的 FAILED 章（`draft/failed/` 有 reject 稿） | 抽读复核；定夺重写 or 永久接受缺口 |

排序：同优先级内按章号升序（保持世界状态时间序）。

## 2. 最小命令循环

```powershell
# 1) 生成/刷新待审清单（JSON + Markdown 摘要，幂等）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.review_worklist

# 2) 审一章（人工读 draft 正文 + 日志 note，改稿放 chapters/draft/chapter_N.txt 覆盖）

# 3) 审完回写：把章号标记已审（进已审清单，下次生成时跳过）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.review_worklist --mark-reviewed 3111,3420
```

- **审而不改**（接受现状）：`--accept 章号`，记录进 `audit/review_accepted.json`；
- **改稿后重跑批次**：`run_volume --only 3111,3420`（若该 flag 可用；否则临时改 checkpoint 移除对应 complete 条目后 `--resume`）；
- **gate 误拦**：改 `config/quality` 阈值或 `decision_rules.json` 条款 → 重跑 audit + 批次。

## 3. 纪律

- 一次只审一个优先级带；P0 清完再进 P1（避免高分章插队拖垮低分缺口）；
- 每审 10 章把结论写进 `docs/superpowers/quality-backlog.md` 顶部（新条目置顶）；
- 改门禁/规则必须跑完整门禁（pytest + pyflakes + npm run check）再进批次；
- **永远单批次**：审稿重采与看护批次共用 checkpoint，不可并行。

## 4. 目标态

- P0（<60）清零或全部 `--accept` 留痕；
- P1 的 hard-gate 拦截章全部改稿过线或门禁条款化修正；
- `review_accepted.json` 与 backlog 条目一一对应，可追溯。

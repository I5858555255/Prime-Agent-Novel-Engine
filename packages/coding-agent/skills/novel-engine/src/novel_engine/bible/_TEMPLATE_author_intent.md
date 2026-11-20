# 作者意图 Bible 模板（换书复制为 bible/author_intent.md）
> 复制本文件为 `bible/author_intent.md`。
> **每个阶段标题 `## 第N阶段：[卷名]（第A-B章）` 必须与 `volumes.json` 的 `intent_marker` 一致。**
> forbidden 条款需与 `config/planning/decision_rules.json`（R 条款）对应，覆盖审计 K=0。

## 第一阶段：[卷名]（第1-[末章]章）
- [ ] forbidden：[本阶段禁止什么]
- [ ] allowed：[允许模糊到什么程度]
- [ ] 锚点：[F00x 类伏笔在本阶段的边界]

## 第二阶段：[卷名]（约第[起]-[止]章）
- [ ] forbidden / allowed / 锚点
…（按 volumes.json 卷数追加）

> 条款判定化：V0x forbidden 全部进 decision_rules.json；未条款化的卷在
> 对应卷批次进入时覆盖审计会挂起（防无人值守漏判，不静默放行）。

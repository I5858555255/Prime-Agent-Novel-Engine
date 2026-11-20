# 换书 bible 五件套模板（复制改名后逐条填，勿留 `[ ]` 未勾）

> 用法：把本目录 5 个模板复制为 `bible/<name>_bible.md`，把 `[ ]` 改成 `[x]` 并填值。
> 体量上限见 §使用说明.md §九。`style_bible.md` 第一行必须含"视角"（writer 自动注入）。
> `author_intent.md` 阶段标题必须与 `volumes.json` 的 `intent_marker` 匹配。

## 1. `world_bible.md`（世界观/力量体系，≤2KB）
- [ ] 时代/地理/势力版图
- [ ] 力量体系（境界/道具/规则），与大纲修炼境界对照表一致
- [ ] 核心规则与红线（什么不能发生）

## 2. `character_bible.md`（人物档案 C001…，≤1.5KB/角色）
- [ ] 每个角色：编号/姓名/身份/认知边界/信息边界
- [ ] 角色关系表
- [ ] 与 `character_registry.json` 登记的 token 一致

## 3. `style_bible.md`（文风，≤1KB）
- [ ] **第一行写视角**：如"1. 第三人称有限视角，以主角[主角名]为主视角…"
- [ ] 文风/断句/对话占比/比喻纪律（对应 reviewer 评分维度）

## 4. `author_intent.md`（按阶段 forbidden 条款，阶段标题=intent_marker）
- [ ] `## 第N阶段：[卷名]（第A-B章）` 与 `volumes.json` intent_marker 一致
- [ ] 每阶段 forbidden 条款 + 锚点（供 R 条款化判定，见 decision_rules.json）

## 5. `ending_bible.md`（终局 + 伏笔回收窗口）
- [ ] 终局收束（对应 `decision_rules.json` 收束卷"不埋新伏笔"条款）
- [ ] 伏笔回收窗口（与 `foreshadow/registry.json` fid/plant/resolve 一致）

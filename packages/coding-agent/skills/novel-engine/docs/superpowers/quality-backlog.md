# Quality Backlog（novel-engine）

本文件记录质量门/设定贯通相关待办、决策与验收结论。新增条目置顶并标注日期。

---

## 2026-10-04 设定贯通三阶段（封存解封后第一批）— 已修复 ✅

**背景（解封诊断结论，已核实）**：bible/ 目录 5 个设定文件
（world/character/style/author_intent/ending）此前只有前 4 个接入 Director，
Writer 与 Reviewer 两层几乎看不到真实设定内容，对应封存时两个核心症状
（ch48 泄漏、ch25 命名矛盾）：

- ending_bible.md 零代码引用（只有 start.sh 存在性检查 + docs/编写指南.md
  声称"无截断全文发送"——声明与实现不符）。
- reviewer_agent.py 只在 prompt 字符串里提"符合 character_bible/style_bible"
  文件名，从未加载文件内容 → reviewer 对照一份从未见过的文件打分。
- writer_agent._bible_snippet() 硬截断 world[:600]+character[:600]，不含
  author_intent forbidden → writer 从没见过"本卷禁止事项"。

### 阶段 1：ending_bible 接入 Director + 伏笔-终局回收远期校验（commit b7cd5a3a4）

- chapter_director：`_load_bible_cache` / `_build_shared_context` /
  `get_context_for_chapter` 三处 bible_files 增加 `'ending'` 键；
  新增 `_build_ending_anchor_hint`——registry resolve_chapter 距当前 ≤30 章且
  未 resolved 时在 skeleton prompt 注入"临近回收"提示（远期锚点）。
- outline_coverage_gate：新增 `validate_foreshadow_closure` 纯函数，
  importance≥0.7 且 resolve_chapter < current 且未回收 → 硬拦截
  （resolve==current 视为正在回收不拦；registry 全量扫描，不再依赖
  query_active_foreshadows 的 clue_plan 命中——原超期提醒有漏报缺陷）。
- orchestrator `_deterministic_quality_gate`：接入硬拦截，issue 前缀 `[设定]`；
  原 soft 提醒保留。
- db.py：新增 `resolved_foreshadow_ids()`（StateDB status='resolved' 集合）。
- 验证：8 条 hermetic 纯函数测试；pyflakes 0 undefined name；
  全量 1 failed / 1075 passed（唯一 pre-existing 不变）。
- 生产影响：ch1-50 阶段 resolve_chapter 均 1800+，零触发（远期锚点设计使然）。

### 阶段 2：Reviewer 注入设定对照块 + 前世揭示尺度 soft_warn（commit ba14ccf31）

- reviewer_agent：新增 `_build_setting_block`——按 author_intent 分卷标题
  （`## 第N阶段：xxx（第A-B章）`）切分当前卷 forbidden 列表 + character_bible
  全文 + style_bible 全文注入 review prompt（合计约 4KB）；评分指令第 3 条
  强化为"对照设定对照块逐条核对，违反按'设定违规'单独归类"。
- 前世揭示尺度（ch48 口径决策）：**不做 hard block**。character_bible C001
  将"神魂跨界重生"定为既定身份（角色本人知道，不违反设定）；author_intent
  十卷 forbidden 无前世/转世禁令（已 grep 核实零命中）。真正问题是揭示节奏/
  笔触分寸 → 新增 `quality/reveal_scale_gate.py`：150 字窗口 ≥3 个前世具象
  细节词（病床/咽气/白墙/吊瓶等）→ soft_warn（不阻断，计入打分供人工审阅）。
  阈值/词表在 config/quality_thresholds.json `past_life_reveal` 可调。
- orchestrator：build_deterministic_signals 后追加 past_life_reveal 信号，
  确定性检测注入 reviewer，不新增 LLM 调用。
- 验证：10 条 hermetic 测试；pyflakes 0 undefined name；
  全量 1 failed / 1085 passed。

### 阶段 3：Writer 按卷定向注入替代固定 600 字截断（commit 06471dec7）

- writer_agent：`_load_bible_cache` 增加 author_intent 键（此前从未读到
  forbidden，这是 ch11/ch48 犯错的直接原因之一）。
- `_bible_snippet` 改造：当前卷 forbidden 完整注入（不截断，核心变更）；
  character_bible 按本章出场角色名定位段落（participants/characters，
  失败退回 600 字兜底）；world_bible 按地点/势力名定位（location/place，
  同样兜底）。
- 验证：7 条 hermetic 测试（分卷切片/定向命中/兜底三分支）；
  pyflakes 0 undefined name；全量 1 failed / 1092 passed。

### 复验结论（如实记录，不只有成功部分）

- ch48：合成 fixture 验证 reveal_scale_gate 对"病床/咽气/前世弥留"段落正确
  判 HIGH 且为 soft（不阻断）；合法提及（单词、无细节堆叠）不触发。
  真实 LLM 全流程复跑未做（不强制，见任务书"优先合成 fixture"条款）。
- ch25（命名矛盾）：不保证 100% 消除——命名矛盾属于"质量类失败"范畴，
  不完全是设定贯通能解决的。Writer 现在能看到更完整的定向 character_bible
  段落，应降低概率；若真实复跑仍失败，归因到质量类确定性修复通道（下述
  未做项），不是本批改动失败。

### 本批明确不做（保持 backlog 优先级，另排）

- `_decide_publish` 拒绝原因不落盘（发布可观测性）。
- 质量类失败（如命名矛盾）无确定性修复通道。
- 不改写 bible 内容、不顺手扩充 forbidden 条款（若接线后 ch11/ch48 类问题
  依然存在，用具体反例句子单独处理，不与接线混做）。

---

## 历史要点（压缩自前序会话，供追查）

- 工程纪律（写入 orchestrator-boundaries.md）：提取/委托禁
  `staticmethod(lambda self,*a,**k)`；外部变量显式入参；每阶段提交前
  pyflakes 全包 0 undefined name + 全量 pytest 仅允许 1 个 pre-existing
  （test_same_location_cluster_shared_objects_not_flagged）；新测试必须
  hermetic（合成 fixture，不依赖被 .gitignore 排除的真实产物）；提交前在
  干净 clone 复核。
- 已修复根因库见 docs/superpowers/../novel-engine-runner 技能
  references/root-causes.md（12 条）。
- 概念解锁机制（concept_unlocks，ch6-ch9 真实数据验证生效）：
  词表按概念分组（cultivation_system@6 / martial_identity@15 /
  guardian_identity@20 / xianxia_system@25），scope_gate 先查解锁状态再落
  词表，语境豁免降为兜底。
- 未决待办：ch21+ 创作方向（用户/剧情负责人提供大纲后，先用
  concept_audit.py 纸面推演）；martial_identity@15、guardian_identity@20
  两个解锁点从未在真实跑批中触发，是 ch21-50 第一个必撞窗口。

# Quality Backlog（novel-engine）

本文件记录质量门/设定贯通相关待办、决策与验收结论。新增条目置顶并标注日期。
（本文件为唯一正本；仓库根 docs/ 与 src/docs/ 下的同名文件已废弃为迁移占位，
见 2026-10-04 去重记录。）

---

## 2026-10-05 中文导演话语泄漏检测盲区 — 已修复 ✅

**背景（ch25 真实样本）**：ch25 正文第 156 行"这就是他必须执行的第一个
外部动作：翻阅旧笔记"——纯中文规划式表述泄漏进正文。核实：现有
[泄漏] 检测（scaffold_scrub 的 `[A-Za-z_]\w*`、latin_leak_gate 的
`[A-Za-z]{2,}`、verify_no_scaffolding 的标记 token）全部只抓拉丁字母/
英文/标记型，无任何规则针对中文"导演话语"。

**修复**（quality/repetition_detector.py）：
- 新增 `detect_director_speak_leak()`，两层检测（避免退回逐词打地鼠）：
  - A. 兜底短语正则：`必须执行的第一个(外部|内部)动作`、`接下来/下一步
     要做的`、`这一步的任务是`、`按照安排他需要`、`执行…指令/安排/任务`、
     `本章核心目标` 等规划式句式（有限枚举的句式层）。
  - B. 结构化 schema 词汇反查：chapter_director 的 task_card/prompt 写死
    的内部标签词（"本章核心目标"、"大纲核心任务"、"场景目标"、"场景冲突"、
    "场景情绪"、"情节点"、"外部动作"、"内部动作"、"concrete_events"、
    "must_cover_beats" 等）原样出现在正文即判 [泄漏]——检查"内部实现的
    词汇泄漏到外部产物"，集合由代码自身定义、有限，不依赖人工逐条补词。
- 接入 verify_no_scaffolding（pipeline 自动加 "[泄漏]" 前缀，复用
  _det_fulltext_fix 的 [泄漏] 修复分支"清除该表述"）。

**验收**：新增 5 条 hermetic 测试（ch25 真实实例 + 5 个不同措辞变体 +
4 条正常叙事不误报）；pyflakes 全包 0 undefined name；全量 pytest
1 failed / 1101 passed（唯一已知 pre-existing，无新增）。
**关联记录**：ch25 中纲偏离（图腾兽皮册→伤病记录册）与 A 路线边缘
（陆烬亲自调息、无概念锁词）两项为非阻塞项，随 ch25 gray-band 发布
保留 spot-check 标记。

## 2026-10-04 质量类 det 硬项接入修复通道 — 已修复 ✅

**背景（ch25 重跑坐实的缺口）**：中纲重跑对比显示 ch25 仍失败
（命名矛盾"活井/枯井同章共现" + 终态硬项"跨场危机 off-card 未承接"），
归因**质量类失败**（区别于已修复的设定类）。定位：`_deterministic_quality_gate`
产出的 `[命名矛盾]`/`[跨场危机]`/`[伏笔极性矛盾]` hard issues 检测到了，
但 `_det_fulltext_fix` 的消费前缀集合只有 `[称谓]/[canon/[泄漏]`——质量类
硬项从未进入修复路径，只能靠 force-best 落 draft 等人工。

**修复**（pipeline_orchestrator.py，_det_fulltext_fix + CC33 调用点）：
- 前缀集合扩为 `("[称谓]", "[canon", "[泄漏]", "[命名矛盾]", "[跨场危机]",
  "[伏笔极性矛盾]")`。
- 新增三个指令分支（复用既有"锚点替换 JSON → parse/apply → 重跑 det gate
  门过才采纳"模式，journal 不动）：
  - `[命名矛盾]`：统一同指实体用名，全文替换一致称呼，不得同章同指异名
    且证据成立。
  - `[跨场危机]`：本场景补写对上一场景危机的呼应/推进，不得悬空。
  - `[伏笔极性矛盾]`：补铺垫或调整为与既有伏笔极性一致。
- 质量类与规则类（scope leak/concept_unlocks）检测/修复逻辑保持独立，
  仅复用"接入 fix loop"的通道模式（符合边界文档第 13 节）。

**验收**：新增 2 条 hermetic 回归测试（命名矛盾、跨场危机指令生成与消费，
test_det_fulltext_fix.py）；pyflakes 全包 0 undefined name；全量 pytest
1 failed / 1098 passed（唯一已知 pre-existing，无新增）。

**真实重跑验收（2026-10-05 完成）**：ch25 在新通道下重新走完整流水线
→ **85.3 分、errors=[]，det gate 全过（gates pass），gray-band（85-88）
自动发布至 chapters/novel/chapter_25.txt，标记人工 spot-check**。
对比链：中纲前（命名矛盾 hard block 失败）→ 中纲后旧通道（82.9 分
force-best 落 draft，卡"跨场危机"）→ 新通道（85.3 分自动发布，不再停在
force-best）。任务书验收 b 达成。一次日志记录"[change_validation]
rejected: entity_not_found"（世界状态变更校验拒绝，非致命，属既有机制）。
**遗留**：ch25 以 gray-band 发布，非全绿 88 分；人工抽查标记保留。

## 2026-10-04 backlog 文档去重 — 已修复 ✅

仓库内曾存在三份 quality-backlog.md：src/docs/（278行，停更于封存轮）、
docs/（正本，持续维护）、仓库根 docs/（50行，最早停更）。代码零引用
（纯人读文档）。处理：以 `packages/coding-agent/skills/novel-engine/docs/
superpowers/quality-backlog.md` 为唯一正本；另两份替换为一行迁移占位，
提交说明记录原因。教训：路径只差 src/ 层级，肉眼极易选错；以后引用
backlog 一律用正本绝对路径。

## 2026-10-04 中纲（章级意图）层 V01 ch21-50 — 草稿已生成+校验，待用户审阅 ⏳

**背景（粒度缺口修复）**：plot_graph.json 49 节点覆盖全书约 50 个锚点章，
ch21-50 仅 43/50 命中节点，其余 28 章此前靠 director"前后 20 章节点+卷主题"
松散参考自由发挥（ch25/ch48 类失败的根源之一）。本批新增"章级中纲"层，
补在 bible（骨架级）与单章大纲（LLM 临场）之间。

### 阶段 1：生成（scripts/generate_mid_outline.py，新建）

- 输入 vid + 章节范围，读取 bible 五文件（author_intent 当前卷 forbidden +
  ending_bible 伏笔时间表）、volumes.json 卷主题/冲突/高潮、plot_graph.json
  邻近节点、foreshadow registry 相关条目、world_state 承接摘要。
- 每章输出：core_event（一句话核心事件）+ characters + boundary_note
  （接近伏笔/forbidden 边界时显式标"需人工确认"，不自行放行）。
- 产物：config/planning/mid_outline_V01_ch21-50.json（meta.status="draft"，
  与 plot_graph.json 同目录同管理，长期可追溯）。
- **踩坑记录（本批）**：
  - siliconflow DeepSeek-V3.2 的 output_json 模式**系统性返回空 content**
    （跨温度重试 4 次仍空，14 批全灭，90 分钟零产出）→ 改为普通文本输出
    + 行解析（`ch<N>|core_event|characters|boundary_note`），3 分 40 秒
    完成 28 章。
  - LLMClient 直接构造时 `_resolve_api_key` 的默认参数（ZLEAP_MODEL_API_KEY）
    与 runtime_config 的 api_key_env（LLM_API_KEY）不一致，且不查
    SILICONFLOW_API_KEY → 显式按 api_base 平台解析 key（siliconflow 优先
    SILICONFLOW_API_KEY）。此问题同样影响 run_volume 之外所有直接用
    LLMClient.from_config_dict 的脚本，后续统一修订。
  - 生成脚本支持 `--only 31,48` 重生成指定章并合并回主文件（覆盖式），
    用于撞锁条目的定向重跑。

### 阶段 2：校验（scripts/audit_mid_outline.py，新建）

- 复用 concept_audit 思路：detect_scope_violations（concept_unlocks 硬锁/
  软锁）+ author_intent forbidden 子串 + 新增 **A 路线主语模式判定**
  （陆烬亲自修炼样式动作：练习/运转/引气/吐纳/打坐/调息/催动、陆烬体内
  气机运转/共鸣——纯词表判不出，须按主语紧邻模式，避免"旁观陈老根练习"
  误判）。
- 结果：通过 23 章 / 需人工确认 5 章（ch31/35/40/42/45，均为模型自标
  伏笔/身世/修炼边界，待用户审阅）/ 直接撞锁 0 章（ch31、ch48 初版撞
  A 路线红线已用 --only 重生成修正；ch39 为审计模式误报已修）。
- **使用门禁**：Director 只读 meta.status=="approved" 的产物；audit 通过、
  用户审阅后由脚本将 status 置为 approved，否则永远不可用（物理门禁）。

### 阶段 3：接入 Director（chapter_director.py 修改）

- `_load_mid_outline_entry(chapter_num)`：扫描 config/planning/mid_outline_*.json，
  仅接受 approved 条目；无则返回 None。
- `_build_mid_outline_hint(entry)`：格式化强约束文本（core_event + 涉及角色
  + 边界注意）。
- `_build_shared_context` 注入 `mid_outline_entry` / `mid_outline_hint`；
  `_call_scene_skeleton` prompt 在"相关剧情节点"之后注入中纲行；无 approved
  条目时退回原松散参考逻辑。
- 4 条 hermetic 测试（tests/test_mid_outline_director.py）：approved 注入 /
  draft 不注入 / 无文件退回 / 任意非 approved 状态不可用。

### 阶段 4：验收

- pyflakes 全包 0 undefined name；全量 pytest 1 failed / 1096 passed
  （唯一失败为已知 pre-existing test_same_location_cluster_shared_objects_not_flagged，
  无新增）。
- **待办（用户审阅后）**：ch21-50 中纲重跑对比（通过率/返工轮数 vs 松散
  参考基线），结果如实追加本文件；ch25/ch48 专项复验。

### 待用户审阅（5 章需人工确认，approved 标记后 Director 才启用）

**2026-10-04 已审阅（用户逐条拍板）**：
- ch31 放行（异域尸骨=禁区边缘出事的物证，不等于"根源被点明"，合规悬念）。
- ch35 放行（呼吸法疗伤祛毒为表面功效；F002 真正揭示在第四卷 ch939，
  不碰核心反转）。
- ch40 放行（F001 三残物"第五卷起分阶段拼凑、ch3025-3035 落地、约
  ch3400 前完成"；第一卷埋首件实物正合超长引线设计）。
- ch42 **修改后放行**（原"认出文字相似+神色凝重"触及"陈老根来历被揭穿"
  实质一步；按指定文案改为：陈老根看到残石后沉默不语，只含糊说了句
  "莫要多想"便将其收起，去掉"认出关联"与"神色凝重"两个具体反应）。
- ch45 放行（文物线索+含糊带过，标准悬念，无实质信息）。

**结果**：meta.status 已置 "approved"（2026-10-04），28 条整批可用
（文件级门禁：audit 通过 + 用户审阅后整批激活；含 24 条自动通过 + 4 条
放行 + ch42 修改版）。复验 audit：0 撞锁。

### 阶段 4 续：真实 LLM 重跑对比（ch48/ch25）

**2026-10-04 重跑完成**（中纲 approved 生效后，真实 LLM 单章全流程，
scripts/rerun_mid_outline_verify.py；结果 runtime/mid_outline_rerun_result.json）：

| 章节 | 中纲前（基线） | 中纲后重跑 | 结论 |
|---|---|---|---|
| ch48 | 失败：前世/重活一世内容泄漏（reviewer 对照不存在的设定打分） | **通过**：87.1 分，errors=[]，20.7 分钟 | ✅ 设定贯通+中纲修复了泄漏类失败 |
| ch25 | 失败：命名矛盾（活井/枯井同章共现） | 仍失败：82.9 分 force-best 至 draft（57 分钟），命名矛盾复现，终态卡硬项"跨场危机 off-card 未承接" | ⏳ 质量类失败，非设定贯通范围 |

**归因**：ch48 属于"设定类"失败（Writer/Reviewer 看不到 bible），已由
设定贯通三阶段 + 中纲约束修复；ch25 属于"质量类"失败（命名一致性/
场景承接），对应 backlog 已有待办"质量类失败（如命名矛盾）无确定性
修复通道"——本次重跑确认该通道缺失仍是真实缺口，优先级提升。
**遗留动作**：质量类确定性修复通道（命名矛盾检测 → 定点修复指令，
参照 _det_fulltext_fix 模式）列为下一批任务；ch25 的 draft 已落盘
chapters/draft/chapter_25.txt（82.9 分），等通道上线后重跑。



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

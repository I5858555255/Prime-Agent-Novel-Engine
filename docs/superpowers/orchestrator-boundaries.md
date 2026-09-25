# PipelineOrchestrator 职责边界梳理

**文件**: `packages/coding-agent/skills/novel-engine/src/novel_engine/pipeline/pipeline_orchestrator.py`
**基准 commit**: `1972ab8` | 5960 行 | 1 个类 | 75 个方法
**分析日期**: 2026-09-25
**范围**: 只读分析，无代码改动。产出为拆分施工图。

---

## 0. 最重要的发现

### 0.1 病灶是一个方法，不是一个文件

`generate_single_chapter`（L442–L1727，**1285 行，占全文件 21.5%**）本身就是一台缩微版的整条流水线：

- 直接内联 quality_policy 读取（10+ 处）
- 调用 `_deterministic_quality_gate`（门控裁决）
- 调用 6+ 个 remediation 方法
- 6+ 处分散的 draft/ 文件写入（无独立方法）

过去 30+ 轮 round 补丁绝大多数改的就是这个方法的某个 if 分支。**拆文件如果不先拆这个方法，等于换个地方继续打地鼠。**

### 0.2 "发布"边界跨三个文件

`chapters/novel/` 的实际写入在：
- `core/checkpoint.py`
- `agent_api.py`

orchestrator 本身只写 `chapters/draft/`。物理拆分时"发布提交"这一类职责必须跨文件一起设计，不能只在 orchestrator 内部找。

### 0.3 恢复职责已部分迁出

Task-11（commit `1972ab8`）把 `save_resume_state` 迁到 `production_runner.py`。orchestrator 里只剩"加载初始输入"（task_card/synopsis/world_state/journal），与"断点恢复状态"已是两件事。

---

## 1. 五类职责的方法清单

### A. 状态机 / 阶段驱动（Stage Driver）

入口和跨章节编排，负责"下一步该跑哪个阶段"。

| 方法 | 行数区间 | 备注 |
|---|---|---|
| `__init__` | L181–L343 | |
| `generate_single_chapter` | L442–L1727 | **god method**，见 §0.1，内部混杂 B/C/D 三类 |
| `_stage_world_sim` | L1727–L1735 | |
| `_stage_directing` | L1735–L1928 | |
| `_stage_synopsis` | L1928–L1955 | |
| `_stage_write` | L2669–L2909 | |
| `_stage_review` | L4305–L4645（340行） | 内部也调用门控 + 触发修复，混了 B/C |
| `_run_with_retry` / `_attempt_temperature` / `_record_slo_failure` | L5527–L5574 | |
| `_run_chapters_gated` | L5574–L5606 | |
| `run_mini_test` / `run_medium_test` / `run_full_unattended` / `run_remediation_and_finalize` | L5606–L5685 | 外部入口，编排层 |
| `_rollback_world_to` / `_recover_chapter` / `_regenerate_chapter` | L5387–L5445 | 失败恢复路径 |
| `_sync_db_if_changed` / `_load_session_tree` / `_save_session_tree` / `_load_director_fixed_context` | L343–L421 | |
| `close` | L5949 | |

### B. 门控裁决（Gate Adjudication）

判断"这版文本能不能过"，是最该有单一真值源的部分。

| 方法 | 行数区间 | 备注 |
|---|---|---|
| `_deterministic_quality_gate` | L1972–L2145 | 中心裁决方法 |
| `_run_continuity_gate` | L2931–L3032 | |
| `_run_scope_gate` | L3032–L3157 | |
| `_run_density_gate` | L3157–L3269 | |
| `_run_scene_progression_gate` | L3269–L3425 | |
| `_run_cross_scene_repeat_gate` | L3425–L3509 | |
| `_run_latin_leak_gate` | L3548–L3600 | |
| `_run_pov_interiority_gate` | L3600–L3665 | |
| `_run_constraint_compliance_gate` | L3665–L3724 | |
| `_run_punctuation_health_gate` | L3724–L3854 | |
| `_run_final_precommit_gate` | L3967–L4037 | |
| `_run_boundary_reprise_gate` | L4037–L4098 | |
| `_run_boundary_gate` | L4188–L4282 | |
| `_run_continuity_audit` | L5454–L5473 | |
| `_forbidden_violations` | L5501–L5512 | |
| `_review_issue_is_blocking` / `_forbidden_violation_is_blocking`（模块级） | L83–L100 | **backlog 里"reviewer severity 硬映射"任务的确切落点** |

> **12 个 `_run_*_gate` 方法**命名规整、平均 80–150 行、边界干净，是拆分风险最低、可第一批动手的部分。

### C. 修复 / 补救（Remediation Loop）

输入是门控失败结果，输出是重写后文本。天然应独立为 `remediation/` 子模块，接口 `(text, gate_failure) -> new_text`。

| 方法 | 行数区间 | 备注 |
|---|---|---|
| `_validate_and_regen_scenes` | L2212–L2532（320行） | |
| `_scene_issues_to_directives` / `_regen_scene_for_id` / `_cc25_rescue_scene_l2l3` | L2532–L2669 | |
| `_punct_only_repair` / `_repair_paragraphs_punct_parallel` / `_repair_paragraphs_punct_batched` | L3509–L3548, L3854–L3967 | |
| `_apply_length_floor` | L4098–L4188 | |
| `_enforce_word_count` | L4645–L4736 | |
| `_enforce_mandatory_beats` | L4736–L5046（310行） | |
| `_patch_weak_scenes` | L5046–L5260（214行） | |
| `_cc25_literary_rewrite` / `_rewrite_weak_dimensions` | L5288–L5387 | |
| `_finalize_current_novel` | L4282–L4305 | 标点/长句收尾，幂等 |

### D. 发布 / 持久化（Publish & Journal）— 跨文件

| 位置 | 内容 |
|---|---|
| `pipeline_orchestrator.py`（本文件） | 写 `chapters/draft/*.txt`、`chapters/draft/failed/*`，散落在 `generate_single_chapter` 内 6+ 处（无独立方法） |
| 本文件 | `_journal_validated_scenes` / `_write_polish_flags` / `_load_journal_scenes` / `_sync_journal_from_draft` / `_assemble_chapter_text` |
| **`core/checkpoint.py`** | 实际写 `chapters/novel/*.txt`（正式发布）、备份、回滚 |
| **`agent_api.py`** | 也直接读写 `chapters/novel/`，路径与 checkpoint.py 部分重复 |

> **关键发现**: "发布"职责分散在三个文件里，没有单一入口。路径拼接 `chapters/novel/chapter_{n}.txt` 在 `checkpoint.py` 和 `agent_api.py` 里各写了一遍。建议先抽共享函数，成本很低。

### E. 恢复（Resume）— 已部分迁出

| 方法 | 行数区间 | 备注 |
|---|---|---|
| `_load_task_card_file` / `_load_synopsis_file` / `_load_world_state_file` | L5685–L5703 | 加载"初始输入"，非断点恢复 |
| `_load_journal_scenes` | L2205–L2212 | |
| （断点恢复状态本身） | 已迁移至 `production_runner.save_resume_state`（Task-11） | |

### F. 杂项 / 工具函数

`_novel_string`、`_ensure_chinese`、`_extract_keywords`、`_bpt`、`_structure_fingerprint`、`_beat_to_str`、`_is_coherent_short`、`_normalize_blueprint_beats`、`get_cost_sandbox_report`、`_flag_for_human`、`_apply_sequence_order`。体量小、依赖少，拆分时顺挪到 `utils.py`。

---

## 2. 交叉依赖 / 坏味道清单

拆分前必须先解决，否则拆完还会互相调用。

### 2.1 God method：`generate_single_chapter`
同时内联调用 B（`_deterministic_quality_gate`）、C（多个 remediation 方法）、D（draft 写入）。**这是唯一一个横跨三类职责的方法**。拆分顺序建议：
1. 先把 B、C、D 的部分抽成"仅接收状态、返回结果"的纯函数调用
2. 最后 `generate_single_chapter` 只剩状态机编排本身
3. 不要直接把整个方法搬到某个新文件

### 2.2 `_stage_review`（L4305–L4645，340行）
同时做门控判断和触发修复，是第二个需要"先拆职责再拆文件"的方法。

### 2.3 `load_quality_policy(self.root)` 被直接调用 20+ 次
散布在 A/B/C 三类方法里，没有统一通过"policy context"对象传递。每个子模块都会各自 import + 各自读文件。建议：在最外层状态机里读一次，通过参数传给 B/C 类方法。

### 2.4 `chapters/novel/` 路径拼接重复
`checkpoint.py` 和 `agent_api.py` 各手写了一遍 `"chapters" / "novel" / f"chapter_{n}.txt"`。先抽共享函数，作为"发布边界"拆分的第一步。

### 2.5 12 个 `_run_*_gate` 边界最干净
命名一致、依赖最少，是拆分风险最低、第一批可动手的部分。

---

## 3. 建议的拆分顺序

**不是本次任务范围，仅供排期参考。**

### 第一批（低风险，可单独排期）
- 12 个 `_run_*_gate` → 独立 `gates/` 子模块
- 每个配一条现有 regression 测试搬过去验证
- 预计耗时：1 session

### 第二批
- C 类 remediation 方法 → 独立 `remediation/` 子模块
- 接口统一为 `(text, gate_result) -> text`
- 预计耗时：1–2 sessions

### 第三批（风险最高，建议留到最后，且要专门 session）
- 把 `generate_single_chapter` 按"编排 vs 门控 vs 修复 vs 发布"拆开
- 只保留状态机本身在 orchestrator 里

### 并行动作（低成本，可随时做）
- `chapters/novel/` 路径拼接 → 抽共享函数（`core/checkpoint.py` + `agent_api.py`）
- 模块级 `_review_issue_is_blocking` / `_forbidden_violation_is_blocking` — 这是 backlog 里"reviewer severity 硬映射"的确切落点，等 beats pilot 稳定后直接在这里接入

---

## 4. 与 backlog 的关联

| Backlog 条目 | 对应方法/位置 | 状态 |
|---|---|---|
| reviewer severity 硬映射 | `_review_issue_is_blocking` / `_forbidden_violation_is_blocking`（L83–L100） | 等 beats pilot |
| Task-11 休眠方法 | 已删除（commit `1972ab8`） | ✅ 完成 |
| force-best log 文案 | 已修复（commit `1972ab8`） | ✅ 完成 |
| force-note 快照 | 已修复（commit `1972ab8`） | ✅ 完成 |

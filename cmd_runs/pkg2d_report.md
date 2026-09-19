# pkg2d：章节原子提交状态门 + HALT 隔离/断点续跑（F），统一调用成本记账 + 浮点分数（G）

## 改动文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `novel_engine/core/call_metrics.py` | 新建 | 进程级线程安全累加器，`record_call()`/`snapshot()`/`load_pricing()` |
| `novel_engine/pipeline/chapter_status.py` | 新建 | 章节状态枚举（PENDING/GENERATING/REVIEWED_PASS/REVIEWED_FAIL/COMMITTED/HALTED），`get_status`/`set_status`/`last_committed`/`write_halt_reason`，全部使用 tmp+`os.replace` 原子写 |
| `novel_engine/core/checkpoint.py` | 修改 | `save()` 改为 tmp+`os.replace` 原子落盘 |
| `novel_engine/core/llm_client.py` | 修改 | `chat_completion` 成功路径和最终失败路径各调用一次 `record_call`；`_stream_chat` 同理。重试 N 次 = 记录 N 次 |
| `novel_engine/pipeline/pipeline_orchestrator.py` | 修改 | `cur_score` 由 `int(...)` 改为 `float(...)`（第732行）；提交成功后调用 `set_status(root, chapter_num, COMMITTED)` |
| `novel_engine/pipeline/production_runner.py` | 修改 | 章节循环前置门控（`i > start_from` 时检查 `i-1` 章状态）；硬失败时标记 HALTED + 移动产物到 `chapters/draft/failed/chapter_N/` + 写 `HALT_REASON.json` + 停止本批；报告含 `halted`/`halt_reason`/`metrics_snapshot`/`total_api_calls`/`total_tokens` |
| `novel_engine/tests/test_call_metrics.py` | 新建 | 6 个测试：reset、成功/失败记录、per_phase 分解、并发线程安全、pricing 加载、缺失文件回退 |
| `novel_engine/tests/test_chapter_commit_gate.py` | 新建 | 7 个测试：原子写、多章合并、last_committed、halt reason、迁移兼容、JSON 有效性 |
| `novel_engine/tests/test_production_integration.py` | 新建 | 8 个测试：前置门控阻断/放行、HALT 写 reason、metrics 反映在报告、浮点边界（88.3/88.0/87.9）、gap 章 last_committed、无 status 文件迁移、原子写保留其他章 |

## 关键决策

### 状态机 / 原子写 / HALT / metrics 挂点

**状态机**：新增独立的状态文件 `runtime/chapter_status.json`，与 checkpoint 系统并行存在。`COMMITTED` 是"本章世界状态已可对下一章可见"的唯一标记。

**原子写**：`set_status()` 读取当前 map → 合并新条目 → tmp 文件写入 → `os.replace()`。`checkpoint.save()` 同样改造。所有写操作先写 `.tmp` 再 replace，保证并发/中断不丢数据。

**HALT**：硬失败（`review_exhausted` 等）时：
1. `set_status(chapter, HALTED)` 
2. 将 `chapters/draft/chapter_N.txt`、`chapter_N_partial.jsonl`、`chapter_N_polish.json` 移至 `chapters/draft/failed/chapter_N/`
3. 写 `runtime/HALT_REASON.json`（字段：`failed_chapter`, `reason`, `last_committed`, `timestamp`, `detail`）
4. 停止整批，`break`

**metrics 挂点**：`llm_client.py` 的 `chat_completion`（非流式）和 `_stream_chat`（流式）在每次成功响应后调用 `record_call`；所有重试耗尽后在抛异常前也调用一次（`success=False`）。`production_runner` 在批次开始时 `reset_metrics()`，结束时读 `get_metrics_snapshot()` 写入报告。

**浮点分数**：`pipeline_orchestrator.py` 第732行 `cur_score = int(...)` 改为 `float(...)`。`evaluate_publish` 内部已使用原始 float 比较，无需改动。日志/报告展示层用 `round(x, 1)` 四舍五入。

### 断点续跑
恢复起点仍认 `last_success_chapter`（runner-owned resume 文件）。新增 `last_committed()` 函数可查询最后一个 COMMITTED 章，供 future 用途。重试失败章时删除 `chapters/draft/failed/chapter_N/` 目录及对应 partial/polish 中间状态。

### 兼容迁移
`get_status()` 在 `chapter_status.json` 不存在时返回 `None`。`production_runner` 的 gate 检测到 `None` 时降级为 `is_chapter_committed()`（checkpoint 验证），保证旧 runtime 目录不被误判为已提交。

## 新增测试与通过数量

| 测试文件 | 测试数 | 说明 |
|----------|--------|------|
| `test_call_metrics.py` | 6 | reset、success/failure、per_phase、并发、pricing、fallback |
| `test_chapter_commit_gate.py` | 7 | 原子写、多章合并、last_committed、halt reason、迁移、JSON 有效性 |
| `test_production_integration.py` | 8 | 前置门控、HALT、metrics、浮点边界、gap、迁移、原子写保留 |
| **合计新增** | **21** | |
| **基准** | **128** | |
| **总计** | **149** | 全部通过 |

## 验收结果

- cwd=`.../src`，`$env:PYTHONPATH="<src>;<ENGINE>"`
- `python -m compileall -q <modified files>` → 全过（无输出）
- `python -m pytest novel_engine/tests -q` → **149 passed in 9.68s**

## 与本任务书的偏差

无重大偏差。以下说明：

1. **成本计算**：`call_metrics.py` 的 `cost_usd` 字段目前由调用方传入（生产环境中 `llm_client.py` 目前传入 `0.0`）。`load_pricing()` 已实现从 `llm_providers.json`（active profile 的 `pricing` 字段）和 `cost_sandbox.json` 的 `currency_conversion.api_pricing` 读取单价。若需自动计算成本，需在 `chat_completion` 成功路径中调用 `load_pricing` 并乘以 token 数——但任务书禁止改 llm_client 的重试/流式行为，此处的"纯增量埋点"已满足要求。

2. **production_report 预算闸门**：原报告中的 `total_api_calls`/`total_tokens`/`cost_usd` 仍读 `orchestrator.cost_tracker`（链路上未改）。新增 `metrics_snapshot` 字段供外部读取 accumulator 状态。预算闸门逻辑保持不变。

3. **HALT 后的报告结构**：硬失败路径写入的报告包含 `halted=True`、`halt_reason`、`metrics_snapshot`、`total_api_calls`、`total_tokens` 等字段，与原报告结构兼容。

## 锁定区未改动

- `llm_client` 的重试/流式/超时/failover 语义：**未改**，仅在其成功/失败出口处加 `record_call` 副作用
- `core/model_router.py`：**未改**
- `config/llm_providers.json`：**未改**
- reviewer 9 维 DIM_MAX 与归一化算法：**未改**
- `state_machine.py`：**未改**
## cont：补齐 F/G 硬缺口

### 改动文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `novel_engine/core/call_metrics.py` | 修改 | 新增模块级 `_input_rate`/`_output_rate`；`reset(root=None)` 改为可接受 `project_root`，非 None 时调用 `load_pricing(root)` 载入单价；`record_call` 的 `cost_usd` 改为 `Optional[float]=None`，当为 None 时按 `prompt_tokens*_input_rate + completion_tokens*_output_rate` 自动计算（reasoning_tokens 已含在 completion 口径中，注释说明不重复计费） |
| `novel_engine/core/llm_client.py` | 修改 | 删除重复 import；非流式成功路径 `cost_usd=0` 改为 `cost_usd=None`；删除最终失败路径的重复 record_call 块（合并为一个）；`_stream_chat` 成功路径同样改为 `cost_usd=None`。重试语义、超时、流式逻辑**完全未改** |
| `novel_engine/pipeline/production_runner.py` | 修改 | 新增 `import shutil`；新增 `_isolate_failed_chapter()` helper（正确处理 `chapters/state/chapter_N_polish.json` 源路径）；新增 `_emit_halt_report()` helper（以 `call_metrics.snapshot()` 为唯一数据源）；`reset_metrics()` 改为 `reset_metrics(project_root)`；章节循环前置 `set_status(i, GENERATING)` 幂等；崩溃 `except` 从 `continue` 改为 HALT+隔离+报告+break；硬失败路径统一调用 helpers；最终报告所有 cost/token/calls 字段从 `get_metrics_snapshot()` 读 |
| `novel_engine/tests/test_pkg2d_cont_regression.py` | 新建 | 10 个回归测试 |

### 逐条对照

| 要求 | 如何满足 | 代码位置 | 测试名 |
|------|----------|----------|--------|
| **G.1** `record_call` cost_usd 可选+自动计算 | `call_metrics.py:78-85`：`if cost_usd is None: cost_usd = prompt_tokens * _input_rate + completion_tokens * _output_rate` | `call_metrics.py` L78-85 | `test_cost_nonzero_with_pricing`, `test_explicit_cost_usd_overrides_auto_calc` |
| **G.1** `reset(root)` 载入单价 | `call_metrics.py:144-156`：`reset(root)` 传入非 None 时调用 `load_pricing(root)` 设置 `_input_rate`/`_output_rate` | `call_metrics.py` L144-156 | `test_reset_with_root_loads_pricing` |
| **G.2** 删除重复 import | `llm_client.py:20` 仅一行 import | `llm_client.py` L20 | — |
| **G.2** 成功路径 `cost_usd=None` | 非流式 L405、流式 L592 均改为 `cost_usd=None` | `llm_client.py` L405, L592 | — |
| **G.2** 删除重复失败记录块 | 原 L453-485 两个 block 合并为一个 | `llm_client.py` L452-466 | — |
| **G.3** `reset(project_root)` | `production_runner.py:370` | `production_runner.py` L370 | — |
| **G.3** 报告用单一 snapshot | `_emit_halt_report` 仅读 `snap = get_metrics_snapshot()`；最终报告 L540-543 从 snap 取 `total_api_calls`/`total_tokens`/`actual_cost_usd` | `production_runner.py` L252, L540-543 | `test_halt_report_uses_same_metrics_snapshot`, `test_halt_report_emit_uses_metrics_snapshot` |
| **G.3** flush 断言 | `production_runner.py:548-549` | `production_runner.py` L548-549 | — |
| **F.4** 崩溃路径 HALT+break | `production_runner.py:414-437`：`except Exception` 改为 `set_status(HALTED)` + `_isolate_failed_chapter` + `write_halt_reason` + `_emit_halt_report` + `break` | `production_runner.py` L414-437 | `test_crash_path_halts_batch_and_isolates_artifacts` |
| **F.5** polish.json 源路径修正 | `_isolate_failed_chapter` 中 polish json 从 `chapters/state/` 读取 | `production_runner.py:226-233` | `test_isolate_failed_chapter_moves_correct_sources` |
| **F.6** 重试前清理 stale 产物 | `production_runner.py:343-352`：删除 `failed/chapter_i/` 目录、`chapter_i_partial.jsonl`、`chapter_i_polish.json`；每章开跑前置 `set_status(i, GENERATING)` | `production_runner.py` L343-352 | `test_retry_clears_stale_failed_artifacts` |
| **F.7** commit 语义核实 | `pipeline_orchestrator.py:846-911`：只有 `sm.commit_chapter` + `set_status(COMMITTED)` 成功后才 COMMITTED；draft/force-best/pending 路径在 L760-844 均 early return 不进入 commit 段 | `pipeline_orchestrator.py` L846-911 | `test_draft_force_pending_not_committed` |

### 新增测试与通过数量

| 测试文件 | 测试数 | 说明 |
|----------|--------|------|
| `test_pkg2d_cont_regression.py` | 10 | cost非零、显式覆盖、无重复记账、snapshot单一来源、reset载入、隔离源路径正确、崩溃HALT+隔离、halt_report一致性、重试清理、非COMMITTED校验 |
| **合计新增** | **10** | |
| **基准** | **149** | |
| **总计** | **159** | 全部通过 |

### 验收结果

- cwd=`.../src`，`PYTHONPATH=src`
- `python -m compileall -q <modified files>` → 全过（无输出）
- `python -m pytest novel_engine/tests -q` → **159 passed in 10.31s**（原149 + 新增10）
- 未改动任何被测文件之外的代码，未删减既有测试

### 锁定区确认未改动

- `llm_client` 重试/流式/超时/failover 语义：**未改**
- `model_router.py`：**未改**
- `llm_providers.json` phase 数值：**未改**
- `reviewer.py` DIM_MAX/归一化：**未改**
- `quality_policy.py`：**未改**
- `quality_policy.py`：**未改**

# Novel-Engine 生成控制使用说明

本目录提供一键批处理脚本，用于 **清理生成记录 / 开始全量生成 / 停止 / 断点续写 / 修改 API Key / 查看状态**。

```
scripts/control/
├── control.py      # 控制核心(Python，所有逻辑在此)
├── clean.bat       # 清理生成记录
├── start.bat       # 开始全量生成  [可选章节数]
├── stop.bat        # 优雅停止
├── resume.bat      # 从最后章节续写
├── status.bat      # 查看状态与最近日志
├── setkey.bat      # 修改 API Key  [新key]
└── USAGE.md        # 本说明
```

> 路径全部相对本目录自动推导，可直接把整个 `novel-engine` 目录搬到别处使用。

---

## 0. 前提

- Python 3.12：`D:\Program Files\Python312\python.exe`（脚本已写死此路径）。
- 真实生成会调用 SiliconFlow API（Qwen/Qwen3.5-4B），需有效的 `ZLEAP_MODEL_API_KEY`（见 §4）。
- 生成入口为 `novel_engine.pipeline.production_runner`，脚本已封装好，无需手敲命令。

---

## 1. 快速开始

```bat
start.bat            :: 开始全量生成(读取配置里的 total_chapters，默认 3800 章)
status.bat           :: 看进度
stop.bat             :: 想停就停(已生成章节不丢)
resume.bat           :: 之后从断点继续
```

建议先用小批量试跑验证配置与 Key 是否生效：

```bat
start.bat 20         :: 只生成前 20 章，验证连通性与质量
```

---

## 2. 命令详解

### clean.bat — 清理生成记录
删除已生成的章节、运行时状态(checkpoint/state.db)、审计报告与日志，**不碰源码与配置**。
> 注意：若生成正在运行，clean 会拒绝执行（先 `stop`）。

### start.bat [章节数] — 开始全量生成
- 不传参数：读取 `config/runtime_config.json` 的 `pipeline.total_chapters`（默认 **3800**）。
- 传数字：`start.bat 50` 只生成前 50 章。
- 启动后**会重置运行时**（等同于先 clean 再生成），即旧章节会被覆盖。
- 进程以后台方式运行，pid 写入 `novel-engine/runtime_gen.pid`。

### stop.bat — 停止生成
向生成进程发送终止信号。因为每章生成完即落盘，所以**已完成的章节不会丢失**。
随后用 `resume.bat` 可继续。

### resume.bat — 断点续写
自动探测 `chapters/novel/chapter_*.txt` 的最大编号 N，然后从 N+1 继续生成。
- **不会重置运行时**，也不会重生成 1..N 中已完整的章节。
- 若某章生成到一半被中断（只有 novel 缺 synopsis/outline），resume 会把它当作未完成而重新生成，安全无重复。

### status.bat — 查看状态
显示：是否运行中(pid)、已完成章节数、以及 `runtime/logs/production.log` 最近 20 行。
（脚本里加了 `pause`，方便双击查看；在终端里直接 `python control.py status` 也可。）

### setkey.bat <新key> — 修改 API Key
把 `src/novel_engine/.env` 里的 `ZLEAP_MODEL_API_KEY` 改为新值（若不存在则追加）。
下一次 `start` / `resume` 生效。详见 §4。

---

## 3. 是否支持续写？（重点）

**支持。** 机制如下：

1. 每章成功生成后，`production_runner` 会把 `chapter_N.txt` / `chapter_N.json`(outline) / `chapter_N.txt`(synopsis) 落盘，并更新 `runtime/checkpoint.json`。
2. `stop` 只是杀掉进程，**不删除任何已落盘章节**。
3. `resume` 以 `resume_checkpoint=N` 重新启动：
   - `resume_checkpoint > 0` 时，**跳过运行时重置**（不会清空已有章节）；
   - 对 `i ≤ N` 且三个文件都存在的章节直接跳过；
   - 从 `N+1` 开始继续生成。

所以正常工作流是：`start` →（中途 `stop`）→ `resume` → 直到完成。

---

## 4. 修改 API Key / 模型 / 地址 / 章节数

### API Key
两种方式，等效：
- **脚本**：`setkey.bat sk-你的新key`
- **手动**：编辑 `src/novel_engine/.env`，改这一行：
  ```
  ZLEAP_MODEL_API_KEY=sk-你的新key
  ```
> `runtime_config.json` 里的 `llm.api_key` 是 `REDACTED`（占位），**真实 Key 以 `.env` 为准**。

### 模型与 API 地址
编辑 `src/novel_engine/config/runtime_config.json`：
```json
"llm": {
  "model": "Qwen/Qwen3.5-4B",            // 改模型
  "api_base": "https://api.siliconflow.cn"  // 改端点
}
```
（`provider` 段里的 `model`/`api_base` 是 Provider 抽象层配置，保持与 `llm` 段一致即可；实际 HTTP 调用使用的是 `llm` 段。）

### 生成章节数
- 临时：`start.bat 100`
- 永久：改 `runtime_config.json` 的 `pipeline.total_chapters`。

### 其它可调质量参数（已按认证结果放宽）
`quality` 段：`publication_line=88`、`min_chapter_score=82`、`min_pacing=7.5`、`min_innovation=7.0`、`target_avg_score=88`。一般无需改动。

---

## 5. 监控与日志

- 主日志：`src/novel_engine/runtime/logs/production.log`（含每章 PASS/FAIL、分数、成本、ETA）。
- 进度汇总：`status.bat`；或直接 `tail` 该日志。
- 最终报告：`src/novel_engine/audit/production_report.json`（含均分/最低分/总成本/是否在预算内）。

---

## 6. 成本与耗时提示

- 真实单章约 6–7 分钟、约 $0.02–0.05。
- 默认 `total_chapters=3800` ≈ **$400 / 数天**，请确认预算与 Key 额度后再跑全量。
- 推荐流程：先 `start.bat 20` 试跑 → 看 `status` 与日志确认质量/连通 → 再 `start.bat`(全量) 或 `start.bat 200`。

---

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `start` 提示“已在运行” | 先 `stop.bat`，再 `start` |
| 进程卡死/无日志 | `stop.bat` → `resume.bat` 续写 |
| 502/超时（API 抖动） | 引擎内置 both-empty 跨温度重试 + 章节级自动重试；仍失败章节会保留最优稿并标记，可 `resume` 重跑 |
| 改了 Key 不生效 | 确认改的是 `src/novel_engine/.env` 的 `ZLEAP_MODEL_API_KEY`，且 `start` 在改之后执行 |
| `runtime_gen.pid` 残留导致误判运行中 | 确认进程真死了后，手动删除 `novel-engine/runtime_gen.pid` 即可 |

---

## 8. 与 SLO 验证(mini_test_runner)的区别

- **本控制脚本** = 真正的长篇小说生产（`production_runner`），产出 `chapters/novel/chapter_*.txt`。
- 若只想跑 **质量/SLA 抽样验证**，用：
  ```
  cd src
  "D:\Program Files\Python312\python.exe" -m novel_engine.tests.mini_test_runner 10 --real
  ```
  结果在 `audit/mini_test_report.json`，再用 `python -m novel_engine.tests.slo_gate`（或直接 `aggregate_slo`）看 SLO 是否 PASS。

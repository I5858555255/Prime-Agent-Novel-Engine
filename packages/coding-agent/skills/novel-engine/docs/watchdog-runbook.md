# 长批次看护 Runbook（relay_watchdog + noproxy_launcher）

> 本文件是 `scripts/relay_watchdog.py` 与 `scripts/noproxy_launcher.py` 的操作手册，
> 固化自 3800 章生成实战（2026-09 ~ 11/17，批次日志 `run_volume_*.log`，
> 临时脚本 `%TEMP%\_relay_autorelay.py` / `_run_XXXX_noproxy.py` 已入库为参数化版本）。
> 配套：`docs/HANDOFF.md`（交接）、`docs/superpowers/quality-backlog.md`（决策日志）。

## 1. 组件职责

| 组件 | 作用 | 生命周期 |
|---|---|---|
| `run_volume --chapters N --resume` | 生成批次本体（COMMITTED/FAILED 写 checkpoint） | 单批 ~30-60 章后自然退出 |
| `noproxy_launcher` | 以干净环境（剥 8 个 proxy 变量）detached 启动 run_volume | 一次性，启动即返回 |
| `relay_watchdog` | 120s 轮询：run_volume 存活 → 等待；退出 → 按规则起下一批 | 直到 `--final-cap` 达成或 stall 退出 |

**代理变量是 LLM 全挂的头号根因**：DSH 会话注入 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7897`（Clash，常未启动）。LLM 出站层 `httpx` 读代理变量 → 报 `Invalid port: ':1]'`；而 `run_volume` 预检用的 `urllib` 不读代理变量，**预检 200 ≠ LLM 正常**。症状 = 全章 ~17s 快速 FAILED、score=None。两个脚本都内置 `clean_env()`，但**父环境本身已干净时直接 `python -m run_volume` 也可以**（非 DSH 会话）。

## 2. 启动（工作目录 `...\novel-engine\src`）

```powershell
# 1) 起第一批（detached，剥 proxy；已存在 run_volume 时安全退出 0）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.noproxy_launcher `
    --chapters 3490 --resume

# 2) 起看护（pythonw 无窗口；--initial-target 0 = 自动取中纲 approved 覆盖端）
Start-Process -WindowStyle Hidden "D:\Program Files\Python312\pythonw.exe" `
    -ArgumentList "-X","utf8","-m","novel_engine.scripts.relay_watchdog","--final-cap","3800","--initial-target","0"
```

- 看护日志：`%TEMP%\relay_watchdog.log`（每条 `watchdog start / launched / FINAL CAP` 即当前状态）；
- 生成 wrapper 日志：`%TEMP%\run_relay_watchdog.log`（每个批次的 stdout）；
- 运行日志：`runtime/run_volume_<UTC时间戳>.log`。

### target 推进规则（代码行为，勿手改）

- progress（**连续** completed∪skipped 前沿）< target → 原 target 重启（批中中断）；
- progress ≥ target 且 approved 中纲覆盖更远 → 前进到中纲覆盖端（中纲必须领先）；
- 超出覆盖 → 每次 +`--loose-step`（默认 30）松散参考，日志打 note 提醒补中纲；
- progress ≥ `--final-cap` → 退出 0。

### stall 策略

同一 target 连续重启 3 次且**最大已完成章**不动 → 退出 1。
误杀场景：单章 livelock 会同时卡死"连续前沿"和"最大进度"两路探测。处置：

```python
# mark_skipped 后重启看护（模式同历史 _skip_XXXX.py）
from novel_engine.core.checkpoint import CheckpointManager
cm = CheckpointManager()
cm.mark_skipped(<章号>)
cm.save()
```

本次实战永久 skip：ch370（13 次）、ch1757（canon 硬词"呼吸"）、ch2683、ch3092（WRITE_REPLAN livelock，score=None 引擎异常）。

## 3. 停止（顺序很重要）

```powershell
# 先杀看护，再杀生成（反序会在 120s 内被自动补起）
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' or Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'relay_watchdog|run_volume' } |
    Select-Object ProcessId, @{n='cmd';e={($_.CommandLine -split ' ')[0..5] -join ' '}}
Stop-Process -Id <看护PID>
Stop-Process -Id <生成PID>
```

暂停 N 小时后恢复：重新执行第 2 节两条命令即可（`--resume` 会跳过已 COMMITTED 章，
残稿章重做，半截不入档）。

## 4. 排障速查

| 症状 | 根因 | 处置 |
|---|---|---|
| 全章 ~17s FAILED，score=None，`Invalid port: ':1]'` | 代理变量污染（httpx 走死掉的 Clash） | 杀掉 run_volume 与看护，用 noproxy 路径重启 |
| 预检 200 但生成全挂 | 同上（urllib 预检不读代理变量） | 同上；别被预检假象骗 |
| 看护 3 次重启退出 1 | 单章 livelock 卡死双路探测 | `mark_skipped` 该章 → 重启看护 |
| 看护日志 `progress < target` 反复重启 | 批中异常退出（OOM/手工误杀） | 看 wrapper 日志尾；`--resume` 语义安全，直接放行 |
| 中纲覆盖落后于进度 | 批次按松散参考推进 | 收敛间隙补 30 章中纲片（见 `docs/outline-fixes.md`） |

## 5. 播报口径（每 N 小时）

```powershell
# 快照（含连续进度、挂点清单）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.status_snapshot --out "$env:TEMP\_snap.md"

# 最近批次统计（窗口 / COMMITTED-FAILED / 均分 / 最低 5 章 / 失败 note）
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.batch_stats --limit 40

# 看护心跳
Get-Content "$env:TEMP\relay_watchdog.log" -Tail 5
```

注意：`checkpoint.last_complete` 是**最近一次写回的章号**（重试老章会变小），不是最大已完成章；
进度判断用 status_snapshot 的"连续进度"行 + batch_stats 窗口 + draft 最大编号。

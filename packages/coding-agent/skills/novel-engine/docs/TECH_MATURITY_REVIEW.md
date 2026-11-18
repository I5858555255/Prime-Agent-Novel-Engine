# novel-engine 技术成熟度复盘（跨项目复用评估）

> 2026-11-18，3800 章收官后对整个生成流程的稳定性与技术栈运用复盘。
> 配套：`docs/PROCESS_REPRO_3800.md`（复现手册）、`docs/watchdog-runbook.md`（看护操作）、
> `docs/outline-fixes.md`（中纲 flag 决策树）。

## 1. 结论

**可复用，但分层看待**：规划层 + 质量门 + 状态层已经是成熟技术栈；运行编排层
（看护/环境）刚完成入库固化；中纲修复层刚固化为 `outline_repair` 脚本。
**剩余短板集中在内容治理层**（见 §5），跨项目复用前必须先做"项目绑定层"的参数化。

## 2. 成熟度矩阵（按层）

| 层 | 组件 | 成熟度 | 证据 |
|---|---|---|---|
| 状态 | StateDB（SQLite 精确检索）+ Durable Session Tree + checkpoint 断点续跑 | ★★★★☆ | 3800 章 60+ 天跨 3 次停机/误杀后完整续跑，0 状态损坏；checkpoint 以 resume 为准的语义稳定 |
| 质量门 | 三评一致性 / hard-gate / dim-gate / crisis-gate / scope-gate | ★★★★☆ | 3400+ 段 `foreshadow_closure_overdue` 密集说明门禁在工作；缺陷是"拦而不放行"（高分章被 force-best） |
| 规划 | volumes + decision_rules（R 条款化）+ 伏笔 registry + 中纲 | ★★★★☆ | R18→R29 条款化判例链验证了"先条款化再跑批"的纪律；128 片中纲全 approved |
| 运行编排 | `relay_watchdog` + `noproxy_launcher` + `batch_stats`（已入库） | ★★★☆☆ | 看护跑完 3800 章全量，误杀/代理两大坑有 runbook；但仍是"单机 Windows + psutil 轮询"，无常驻/多机 |
| 中纲修复 | `outline_repair`（本次入库） | ★★★☆☆ | 四类 flag 决策树脚本化，幂等；未自动化"缺章自动 --only 补" |
| 内容治理 | 低分章人工复核队列 / writer 退化 / 缺章补写 | ★★☆☆☆ | `needs_human_review` 队列无人消费（3560 章 force-best 积压）；writer 退化无归因；3 章空缺 |
| 可移植性 | 项目绑定层（A 路线 / fid 体系 / R 条款 / 代理坑） | ★★☆☆☆ | 全部硬编码进本项目 bible/registry/rules；换书需重建整套 |

## 3. 已固化的资产（本次收官新增入库）

`scripts/`：`relay_watchdog.py`（看护参数化，FINAL_CAP/stall/双路进度探测）、
`noproxy_launcher.py`（剥 8 个 proxy 变量的 detached 启动器，已存在进程安全 no-op）、
`batch_stats.py`（END 行统计，硬门括号感知）、`status_snapshot.py`（连续进度 + 挂点清单）、
`assemble_full.py`（全书拼接目录，缺章占位含隔离残稿）、`outline_repair.py`（四类 flag 修复器，幂等）。
`docs/`：`PROCESS_REPRO_3800.md` / `watchdog-runbook.md` / `outline-fixes.md` + HANDOFF 收官刷新。

## 4. 稳定性证据（3800 章实战）

- **断点续跑**：3 次停机（用户 8h 暂停、双跑事故、代理回归）后全部 `--resume` 无损恢复，
  残稿章重做、半截不入档；
- **挂点策略**：count=1 冻结下批重采、count=5 自动 skip、livelock 手动 `mark_skipped` + 重启看护，
  4 个 skip 章（370/1757/2683/3092）未阻塞全书推进；
- **中纲滚动铺设**：中纲领先生成 ≥1 片的纪律保持了 3800 章无规划空洞（松散参考仅 30 章步进）；
- **质量趋势**：早期均分 67-70 → 后期 88+ green-gate 章占比上升，force-best 占比下降（LLM 长程改善）。

## 5. 跨项目复用前必须补的短板（按优先级）

1. **项目绑定层参数化**（最大复用障碍）：A 路线 #8、fid 锚点体系、R 条款、canon 硬词表
   全部写死在本项目 bible/registry/`_A_ROUTE_PATTERNS` 里。换书 = 换整套内容约束，
   流程脚本可复用，约束层需按新书重建（这正是 `outline_repair` 把替换表做成模块级常量的原因）。
2. **缺章自动补齐**：`generate_mid_outline` 对 LLM 越界章号直接丢弃（实战 29/30、19/20），
   应在生成器内加自动 `--only` 重试循环，目标 30/30 一次收敛。
3. **低分章治理闭环**：`needs_human_review` 队列（3560 章 force-best）无消费者；
   至少补"谁审、顺序、回写"的最小 SOP，否则 draft 积压无出口。
4. **writer 退化检测**：短篇/分词碎裂/复读（ch1682 根因）无探针，建议
   `quality/writer_degradation_probe.py`（单字行占比、n-gram 重复率、长度分布）。
5. **`foreshadow_closure_overdue` 排布**：3400+ 段 7 条伏笔 resolve 点集中逾期，
   高分章被 hard-gate 拦成 force-best——需决定"补 resolve 点"还是"调门禁为软警告"。
6. **看护去单机化**：当前 `relay_watchdog` 依赖 Windows + psutil + 单进程轮询；
   多机/长跑场景建议加心跳文件 + 锁（防双跑）+ 可选常驻 systemd/任务计划。

## 6. 复用清单（其它全书任务的最小起步集）

- 直接搬：`relay_watchdog` / `noproxy_launcher` / `batch_stats` / `status_snapshot` / `assemble_full`（改 `--final-cap`）；
- 直接搬 + 改常量：`outline_repair`（`_CHAR_REPLACEMENTS`、`_A_ROUTE_NOTE` 换新书角色/硬边界）；
- 必须重建：`volumes.json` / `decision_rules.json` / 伏笔 registry / character_registry / bible 五件套 / A 路线类硬边界；
- 纪律照搬：中纲领先 ≥1 片、剥 8 个 proxy 变量、单批次、先关看护再关生成、
  进度看最大章不看 `last_complete`、`git add` 只加自己改的文件。

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

> **2026-11-18 更新：①②③④⑤⑥ 全部完成**，见 §7 落地清单。

1. ~~**项目绑定层参数化**~~ **已完成**：`config/constraints/project_constraints.yaml`
   约束包（A 路线正则 / 锚点短语 / 合规尾注 / 角色替换表）+ `scripts/constraint_pack.py`
   加载器；`audit_mid_outline` 与 `outline_repair` 均已改为 pack-first（yaml 缺省时
   退回内置默认值，向后兼容）。换书 = 换 yaml，引擎与流程脚本不动。
2. ~~**缺章自动补齐**~~ **已完成**：`generate_mid_outline` 批次内 2 轮自动
   `--only` 式重试（越界章号丢弃后自动重发该批缺章），29/30 不再需要人工触发；
   两轮仍缺才报告"manual --only required"。
3. ~~**低分章治理闭环**~~ **已完成**：`scripts/review_worklist.py` 消费
   `audit/needs_human_review.json`（17572 条 → 3787 章去重），按 P0(<60)/P1(60-81)/
   P2(82-87)/P3(≥88) 分级产出 `audit/review_worklist.json` + Markdown 摘要，
   附最小 SOP（P0 先审 → 补写重生成 → 不碰 checkpoint）。
4. ~~**writer 退化检测**~~ **已完成**：`scripts/writer_degradation_probe.py`
   三类探针（单字行占比 / CJK 4-gram 重复 / 长度低于中位 60%），
   `--dir` + `--limit` + `--json` 参数化，实测对 3763 章 draft 目录可跑。
5. ~~**`foreshadow_closure_overdue` 排布**~~ **机制已就位，决策留给人**：
   门禁行为不变（逾期仍 hard-gate → force-best），但 `review_worklist` 的
   P1 清单现在能直接回答"哪些章被哪条伏笔拦"（reason 字段含 gate 名），
   人工补 resolve 点排布或调门禁有了消费入口。
6. ~~**看护去单机化**~~ **已完成**：`relay_watchdog` 加单实例锁
   （`runtime/relay_watchdog.lock.json`，pid 存活检测，stale 自动接管）
   + 心跳（每 10 次轮询 touch 锁文件，外部监控可区分活/死看护）。
   残余限制已文档化：锁的 create-read 窗口非原子（毫秒级双起仍需人工纪律），
   多机部署需再加网络锁（超出单机范围）。

## 6. 复用清单（其它全书任务的最小起步集）

- 直接搬：`relay_watchdog`（含锁+心跳）/ `noproxy_launcher` / `batch_stats` /
  `status_snapshot` / `assemble_full` / `outline_repair` / `review_worklist` /
  `writer_degradation_probe`（共 8 个流程脚本，改 `--final-cap` / `--dir`）；
- 直接搬 + 改 yaml：`config/constraints/project_constraints.yaml`
  （A 路线正则、锚点短语、合规尾注、角色替换表——**换书唯一必改文件**）；
- 必须重建：`volumes.json` / `decision_rules.json` / 伏笔 registry /
  character_registry / bible 五件套；
- 纪律照搬：中纲领先 ≥1 片、剥 8 个 proxy 变量、单批次、先关看护再关生成、
  进度看最大章不看 `last_complete`、`git add` 只加自己改的文件。

## 7. 落地清单（11-18 提交 + 11-19 收尾）

| 必做项 | 落地物 | 验证 |
|---|---|---|
| 约束包参数化 | `constraint_pack.py` + `project_constraints.yaml` + audit/repair 改 pack-first | pack 加载 4 条 A 路线模式 + 6 个锚点短语，fallback 链完整 |
| 缺章自动补齐 | `generate_mid_outline.py` 批内 2 轮自动重试 | 越界章号丢弃 → 自动 `--only` 重发，仍缺才报人工 |
| 复核 SOP | `review_worklist.py` + `audit/review_worklist.json/.md` + `docs/review-sop.md` | 17572 条 → 3787 章，P0=643 P1=2800 P2=302 P3=42 |
| writer 探针 | `writer_degradation_probe.py` | 30 章最小样本实测：10/30 触发长度 flag（短篇积压可见） |
| 看护锁+心跳 | `relay_watchdog.py` `--no-lock` 可选，默认启用 | 二次启动检测到活 owner 即拒；stale 锁自动接管 |

**11-19 收尾（commit 339865f1e）**：
- **POSIX 端口**：`relay_watchdog` / `noproxy_launcher` 的 detached 启动改
  `os.name` 分支（Windows `creationflags`，POSIX `start_new_session=True`），
  跨机部署不再依赖 Windows API；
- **依赖显式化**：`pyproject.toml` 加 `psutil >= 5.9`（看护/启动器进程探测）；
- **审结闭环**：`review_worklist.py` 加 `--mark-reviewed` 回写
  `audit/review_accepted.json`，重跑自动跳过已审章（3786 章待审 + 2 章已审）；
- **SOP 修正**：`docs/review-sop.md` 脚本名/分级口径与实现对齐（原稿引用不存在的
  `review_queue.py`）；
- **SKILL.md** 脚本清单补齐 5 个新脚本 + 约束包加载器。

门禁：pytest **1302 passed / 1 xfailed**（基线不变）+ pyflakes 0 undefined name。

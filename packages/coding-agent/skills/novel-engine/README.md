# novel-engine

PANE（Prime-Agent Novel Engine）的长篇网文生成引擎：StateDB 精确状态 + 章级流水线（世界模拟 → Director → Writer → Reviewer → 自动修复 → 提交），面向 3800 章规模。

## 先读什么

| 想知道 | 读 |
|---|---|
| **现在跑到哪、下一步做什么、别踩什么坑** | [`docs/HANDOFF.md`](docs/HANDOFF.md)（交接入口，每批更新） |
| 历史决策 / 根因 / 修复 / 验收 | [`docs/superpowers/quality-backlog.md`](docs/superpowers/quality-backlog.md)（唯一正本，条目置顶） |
| 目录与 API 形态 | [`SKILL.md`](SKILL.md) |
| 设定与写作约束 | `src/novel_engine/bible/*.md` |
| 控制脚本说明 | `scripts/control/USAGE.md`（**部分过时**，入口以 HANDOFF 为准） |
| 旧运行手册 | `docs/runbook.md`（**已过时**，仅存档） |

## 目录

```
novel-engine/
├── SKILL.md                    # 技能定义 + 架构 + Agent API
├── docs/                       # 文档（HANDOFF / backlog / bible 说明）
├── scripts/                    # 启动脚本与控制脚本
└── src/
    └── novel_engine/           # 包根 = 数据根
        ├── agents/             # Director / Writer / Reviewer / World Simulator
        ├── core/               # LLM client / 记忆 / 状态机 / checkpoint
        ├── engine/             # StateDB / session tree / patcher / subagent
        ├── pipeline/           # 编排与入口（run_volume 在 scripts/）
        ├── quality/            # 质量门与检测器
        ├── scripts/            # run_volume、中纲生成与审计
        ├── config/             # planning / llm_providers / runtime_config
        ├── bible/              # 设定与写作约束
        ├── chapters/           # novel（发布）/ draft（未达线）/ draft/failed
        ├── runtime/            # checkpoint / state_machine / state.db / 日志
        └── tests/              # 单测 + domain_* 专项目录
```

## 运行

工作目录必须是 `src/`（不是仓库根）：

```powershell
Set-Location .\src
& "D:\Program Files\Python312\python.exe" -X utf8 -m novel_engine.scripts.run_volume --chapters 1726 --resume
```

模型与密钥由 `src/novel_engine/config/llm_providers.json` 的 `active_profile` 决定；密钥只放 `src/novel_engine/.env`，不写进 json。

## 测试

```powershell
Set-Location .\src
& "D:\Program Files\Python312\python.exe" -X utf8 -m pytest novel_engine/tests/domain_gate_wiring -q
```

## 关键约定

- `chapters/novel/` 只收达到发布线（88）或 gray-band 授权的章；88 以下走 force-best 落 `chapters/draft/`，日志仍打 `COMMITTED`。
- `ch370` 累计失败 13 次后永久跳过。
- A 路线 #8：第一阶段陆烬禁止任何修炼样式动作（详见 Bible 与 HANDOFF 第 6 节）。

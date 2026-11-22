# Prime-Agent-Novel-Engine — 小说生成专用仓库

Prime-Agent fork 底座 + Python 小说引擎。本仓唯一用途 = 生成长篇小说；clone 后照本页配置即可启动。

## 目录地图

| 路径 | 说明 |
|---|---|
| `packages/{agent,ai,coding-agent,tui}` | 冻结 TS 底座（v0.7.1），勿改、不跟进上游、不 publish |
| `packages/coding-agent/skills/novel-engine/` | 引擎本体（Python），先读其 README 与其 docs/HANDOFF.md |
| `prime-agent-runtime/` | 构建期拷入 dist 的 RLM 运行时（IPython 内核 + 递归子智能体），非第二引擎，见 `packages/coding-agent/docs/rlm-runtime.md` |
| `OPTIMIZATION_LOG.md` | 引擎优化轮次日志（tracked；其中 `launch_10.bat` 旧引用已加失效注记） |
| `docs/superpowers/` vs 引擎内 `src/docs/superpowers/` | 两棵不同树，勿混 |
| 质量日志正本（唯一） | `packages/coding-agent/skills/novel-engine/docs/superpowers/quality-backlog.md`（约 168 KB，条目置顶） |

## 密钥配置（三步）

1. 变量清单看根目录 `.env.example`（4 变量：`LLM_API_KEY` / `AGNES_API_KEY` / `AGNES_TOKEN_API_KEY` / `ZLEAP_MODEL_API_KEY`；本文件不存密钥）。
2. 密钥写实际文件（不入库）：
   - 入口 B（脱离长跑 `run_volume`）→ `src/novel_engine/.env`，**需双变量**：`AGNES_TOKEN_API_KEY`（active）+ 任一 legacy 名 `AGNES_API_KEY`（preflight `_check_keys` 只认 3 个 legacy 名 `LLM_API_KEY`/`AGNES_API_KEY`/`ZLEAP_MODEL_API_KEY`，可同值）；
   - 入口 A（`launch_prod.bat` 前台）→ 仓库根 `.env`，需含 active 变量 `AGNES_TOKEN_API_KEY`；
   - 通用兜底 = `src/.env`。
3. 核对 active profile：看 `src/novel_engine/config/llm_providers.json` 的 `active_profile`（当前 `agnes_30_token` → 必填 `AGNES_TOKEN_API_KEY`）。

## 启动

- 前台（任意目录可跑）：`launch_prod.bat [chapters] [start_from] [resume]`
- 脱离长跑（agent/终端重启不杀进程；在引擎 `src/` 目录下执行或先设 `PYTHONPATH=packages\coding-agent\skills\novel-engine\src`）：
  `python -X utf8 -m novel_engine.scripts.noproxy_launcher --chapters N [--resume]`（幂等；两入口不可并行跑）

## 文档入口

现状入口 = `packages/coding-agent/skills/novel-engine/docs/HANDOFF.md`；换书 = 同目录 `换书操作手册.md`；
LLM 切换 = `packages/coding-agent/skills/novel-engine/src/novel_engine/config/switch_llm.py`（全路径，勿与 `scripts/control/select_llm.py` 混淆）；
密钥说明 = `packages/coding-agent/skills/novel-engine/src/novel_engine/config/LLM选择器使用说明.md`。

## 边界声明

引擎自包含（对 TS 包零 import）；TS 底层冻结不跟进上游、不做 publish；本地验证只跑 `tsgo --noEmit` + 引擎 pytest（完整 `npm run check` 以 CI 为准，`biome --write` 会改底层文件勿本地跑）。

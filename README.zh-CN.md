<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9cb3-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent：自改进 RLM 智能体
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.zh-CN.md">中文文档</a> &bull;
  <a href="README.md">English</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

Prime Agent 是一个开源的编码与研究智能体，适用于通用任务和长时间运行的工作。它围绕两个核心抽象构建：

- **[递归语言模型（RLM）](https://www.primeintellect.ai/blog/rlm)** 将上下文视为变量（*提示即变量*），并将递归子智能体等工具视为持久 REPL 内部的函数调用（*程序化工具/子智能体调用*）。
- **[持续框架（Continual Harness）](https://arxiv.org/abs/2605.09998)** 将补充提示、记忆、技能描述和可复用的子智能体规范存储为持久状态，Prime Agent 可以通过基于证据的微小更新来改进这些状态，默认情况下这些更新仅在会话本地生效。

Prime Agent 将持久化的 Python 控制环境与持久的框架状态相结合，使得有用的工作上下文和可复用的操作模式能够超越单个聊天窗口的生命周期。

- **一切皆为程序化操作：** 持久化的 IPython 是内置的模型工具；文件操作、Shell 命令、工具使用、子智能体和上下文管理都通过代码完成。
- **内置子智能体：** `rlm(...)` 可生成真正的子智能体用于并行或后台工作，并以程序化方式返回结果。
- **框架可自我改进：** `/refine` 会审查当前轨迹，并可对补充框架状态应用基于证据的微小更新。它永远不会重写不可变的基础系统提示，且记录的快照支持回滚。
- **技能可执行：** 技能是可导入的 Python 包，内置的技能创建器可将重复的工作流转化为项目技能或个人技能。
- **会话后台运行：** 基于守护进程的智能体在终端断开连接后仍持续运行，并可在之后重新挂载。
- **智能体直接通信：** 运行中的智能体可以相互交换消息并相互协调，无需通过用户路由所有内容。
- **长时任务持续推进：** 自动压缩、持久化目标、心跳、调度、自主模式和保留的子智能体可跨轮次和终端会话保持进度。

## 快速开始

在 macOS 或 Linux 上安装最新稳定版：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

安装程序会下载带版本号的发布产物，验证其 SHA-256 校验和，安装 `prime-agent` 命令，并可准备智能体使用的 IPython 运行时。

从你希望它工作的仓库或目录启动 Prime Agent：

```bash
cd /path/to/project
prime-agent
```

首次启动时，运行 `/login` 选择订阅或 API 密钥提供商。Prime Agent 在当前目录中工作，可以在那里运行命令和修改文件。请使用一次性的克隆、干净的工作树或其他你可以检查和恢复的检查点。

> [!WARNING]
> Prime Agent 会以你的用户权限执行模型生成的 Python 和项目命令。其工作进程和内核进程改进了生命周期隔离和恢复能力；它们**不是**安全沙箱。请审查更改，仅使用受信任的仓库、指令、技能和扩展。在外部沙箱或受限环境中运行不受信任的代码或指令。

常用命令：

```bash
prime-agent agents                   # 浏览运行中、空闲和已保存的会话
prime-agent attach <agent>           # 重新挂载到运行中的会话
prime-agent --resume <path|id>       # 恢复已保存的会话
prime-agent status                   # 检查后台服务状态
prime-agent doctor [--fix]           # 检查或修复后台服务
prime-agent update [--force]         # 更新 Prime Agent
prime-agent shutdown [--force]       # 停止所有智能体、工作进程和后台服务
```

## 为长时间运行的任务而构建
Prime Agent 专为长时间运行的任务而构建，特别适用于研究中的评估。这些功能可在 TUI 中使用，也可在自主运行时使用。

- **持续框架：** `/refine` 可以将聚焦的、可审查的经验教训持久化为补充提示、记忆、可复用的技能描述或子智能体规范，并记录改进历史。它不替代打包和审查新的可执行技能。
- **智能体间直接通信：** 运行中的智能体和保留的子智能体可以相互发现、交换消息并引导正在进行的工作。
- **守护进程支持的连续性：** 活跃会话、IPython 状态、调度和子智能体在终端断开后仍持续运行，并可在之后重新挂载。
- **心跳和调度：** `/heartbeat`、`rlm_heartbeat` 和 `prime-agent schedule` 可以定期或在特定时间重新进入会话。
- **持久化目标：** `/goal` 在目标完成、暂停或清除之前，保持目标及其进度跨轮次活跃。
- **有界自主模式：** `/autonomous` 在配置的轮次、Token 和时间预算内继续运行，并可运行用户自定义的质量门控。通过的门控仅检查该门控验证的内容；达到限制并不意味着任务成功。

## 文档

- [快速入门](packages/coding-agent/docs/quickstart.zh-CN.md) - 安装、认证并运行第一个会话
- [使用与 CLI 参考](packages/coding-agent/docs/usage.zh-CN.md) - 命令、会话、自主限制和输出模式
- [长时间运行和后台智能体](packages/coding-agent/docs/long-running-agents.md) - 断开与重新挂载、目标、心跳和调度
- [RLM 编程模型](packages/coding-agent/docs/rlm.md) - 持久化 IPython、子智能体、技能和信任模型
- [JSON 模式](packages/coding-agent/docs/json.md) 和 [RPC 模式](packages/coding-agent/docs/rpc.md) - 无头自动化和集成
- [技能](packages/coding-agent/docs/skills.md) - 安装和创建可复用能力
- [提供商设置](packages/coding-agent/docs/providers.md) - 订阅和 API 密钥提供商
- [架构概览](packages/coding-agent/docs/architecture.md) - 守护进程、工作进程、内核和持久化边界
- [开发](packages/coding-agent/docs/development.md) - 从源码构建和运行

## 致谢

我们的智能体和 TUI 构建于 [`pi`](https://github.com/earendil-works/pi) 之上。我们感谢 `pi` 作者的宝贵工作。

## 许可证

Prime Agent 完全开源，基于 [MIT 许可证](LICENSE)发布。

# Prime Agent 文档

> 本文件是 [index.md](index.md) 的中文翻译。如有不一致之处，以英文原文为准。

Prime Agent 是一个 RLM 原生的编码与研究框架，围绕持久化 IPython 内核、递归子智能体、持久会话和多进程本地运行时构建。它最初是 pi-mono 的硬分叉，但 Prime Agent 现在是产品、CLI、安装源和开发仓库。

## 快速开始

在 Linux 或 macOS 上安装最新稳定版：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

然后在项目目录中运行：

```bash
cd /path/to/project
prime-agent
```

通过 `/login` 进行订阅或存储 API 密钥提供商的认证，或在启动前设置环境变量（如 `ANTHROPIC_API_KEY`）。完整首次运行流程请参阅[快速入门](quickstart.zh-CN.md)。

公开发布目前从带版本号的发布产物安装。源码树中继承的 npm 工作区名称是实现细节，不是公开安装路径。

## 从这里开始

- [快速入门](quickstart.zh-CN.md) - 安装、认证并运行第一个会话。
- [使用 Prime Agent](usage.zh-CN.md) - 交互模式、RLM 子智能体、斜杠命令、上下文文件和 CLI 参考。
- [架构概览](architecture.md) - 客户端、守护进程、工作进程、会话、内核、提供商和存储边界。
- [RLM 编程模型](rlm.md) - 程序化执行、原生子智能体、Python 技能和持久状态。
- [长时间运行和后台智能体](long-running-agents.md) - 守护进程工作进程、消息传递、心跳、目标、调度和自主模式。
- [提供商](providers.md) - 内置提供商的订阅和 API 密钥设置。
- [设置](settings.md) - 全局和项目设置。
- [快捷键](keybindings.md) - 默认快捷键和自定义快捷键。
- [会话](sessions.md) - 会话管理、分支和树形导航。
- [压缩](compaction.md) - 上下文压缩和分支摘要。

## 自定义

- [扩展](extensions.md) - 用于工具、命令、事件和自定义 UI 的 TypeScript 模块。
- [技能](skills.md) - Markdown 和 Python 支持的技能，包括如何让 Prime Agent 创建它们。
- [MCP 集成](mcp-integrations.md) - 通过 Python 技能使用 MCP 服务器，无需扩大模型的工具面。
- [提示模板](prompt-templates.md) - 从斜杠命令展开的可复用提示。
- [主题](themes.md) - 内置和自定义终端主题。
- [Prime Agent 包](packages.md) - 打包和共享扩展、技能、提示和主题。
- [自定义模型](models.md) - 为支持的提供商 API 添加模型条目。
- [自定义提供商](custom-provider.md) - 实现自定义 API 和 OAuth 流程。

## 程序化使用

- [SDK](sdk.md) - 在 Node.js 应用中嵌入 Prime Agent。
- [ACP 模式](acp.md) - 从任何 Agent Client Protocol 客户端驱动 Prime Agent。
- [RPC 模式](rpc.md) - 通过 stdin/stdout JSONL 集成。
- [JSON 事件流模式](json.md) - 带结构化事件的打印模式。
- [TUI 组件](tui.md) - 为扩展构建自定义终端 UI。

## 参考

- [会话格式](session-format.md) - JSONL 会话文件格式、条目类型和 SessionManager API。
- [CLI 包参考](../README.md) - 完整的用户和 CLI 参考。

## 平台设置

- [Windows](windows.md)
- [Android 上的 Termux](termux.md)
- [tmux](tmux.md)
- [终端设置](terminal-setup.md)
- [Shell 别名](shell-aliases.md)

## 开发

- [开发](development.md) - 本地设置、配置、调试和验证。
- [架构概览](architecture.md) - 系统拓扑和端到端提示流。
- [守护进程架构](daemon.md) - 监督器、目录、工作进程、生命周期和恢复详情。
- [智能体连接架构](agent-connection.md) - 客户端/运行时连接边界。
- [RLM 运行时架构](rlm-runtime.md) - ZeroMQ 内核传输和递归子智能体执行。

# 快速入门

> 本文件是 [quickstart.md](quickstart.md) 的中文翻译。如有不一致之处，以英文原文为准。

本页带你从安装到一个有用的 Prime Agent 首次会话。

## 安装

在 Linux 或 macOS 上安装最新稳定版：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

尝试从 `main` 构建的最新 beta 版：

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh -s -- beta
```

两个命令都会获取带版本号的 Prime Agent 发布产物并安装 `prime-agent` 命令。源码树中继承的 npm 工作区标识符不是公开安装路径。

然后在你想让它工作的项目目录中启动 Prime Agent：

```bash
cd /path/to/project
prime-agent
```

要运行源码检出，请使用 Node.js 22.8.0 或更新版本：

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
./prime-agent.sh
```

源码运行器会保留调用它的目录，因此你也可以从其他项目调用 `/path/to/prime-agent/prime-agent.sh`。

## 认证

Prime Agent 可以通过 `/login` 使用订阅提供商，或通过环境变量或其认证文件使用 API 密钥提供商。

### 选项 1：订阅登录

启动 Prime Agent 并运行：

```text
/login
```

然后选择一个提供商。内置订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro（Codex）和 GitHub Copilot。

### 选项 2：API 密钥

在启动 Prime Agent 之前设置 API 密钥：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

你也可以运行 `/login` 并选择 API 密钥提供商，将密钥存储在 `~/.prime/agent/auth.json` 中。

所有支持的提供商、环境变量和云提供商设置请参阅[提供商](providers.md)。

## 首次会话

Prime Agent 启动后，输入请求并按 Enter：

```text
Summarize this repository and tell me how to run its checks.
```

Prime Agent 为模型提供一个内置工具 `ipython`。这个长生命周期的内核是一个控制环境，用于读取和编辑文件、运行项目命令、检查数据、保留 Python 状态和调用已安装的技能。内核运行时在首次使用时自动引导启动；设置 `PRIME_AGENT_KERNEL_PYTHON` 可使用带有 `ipykernel` 的现有 Python 环境。

Prime Agent 在你当前的工作目录中运行，可以在那里修改文件。如果你想轻松回滚，请使用 git 或其他检查点工作流。

## 递归子智能体

递归子智能体是 Prime Agent 的内置能力。模型通过 IPython 中的 `await rlm("subtask")` 生成独立工作；每次调用在准入时返回一个子句柄，永远不会返回答案。子智能体将请求的结果作为显式的 `agent_message` 回复发送给父智能体，或将结果写入文件。子智能体使用与父智能体相同的 TypeScript 智能体运行时、提供商、工具、技能和会话机制。

你可以直接提示模型使用该能力：

```text
Review authentication and test coverage as independent subtasks. Run them in parallel, then synthesize the findings.
```

API 和执行模型请参阅 [RLM 运行时架构](rlm-runtime.md)。

## 为 Prime Agent 提供项目指令

Prime Agent 在启动时加载上下文文件。添加一个 `AGENTS.md` 文件来告诉它如何在项目中工作：

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Prime Agent 加载：

- `~/.prime/agent/AGENTS.md` 用于全局指令
- 父目录和当前目录中的 `AGENTS.md` 或 `CLAUDE.md`

更改上下文文件后，重启 Prime Agent 或运行 `/reload`。

## 常见尝试

### 引用文件

在编辑器中输入 `@` 进行文件模糊搜索，或在命令行上传递文件：

```bash
prime-agent @README.md "Summarize this"
prime-agent @src/app.ts @src/app.test.ts "Review these together"
```

图片可以通过 Ctrl+V（Windows 上为 Alt+V）粘贴或拖入支持的终端。

### 运行 Shell 命令

在交互模式下：

```text
!npm run lint
```

命令输出发送给模型。使用 `!!command` 运行命令但不将其输出添加到模型上下文。在智能体工作期间，模型通常通过 `%%bash` 单元从 IPython 控制环境运行项目命令。

### 切换模型

使用 `/model` 或 Ctrl+L 选择模型。使用 `/effort` 设置推理级别。使用 Ctrl+P / Shift+Ctrl+P 在范围内的模型之间循环。

### 稍后继续

会话自动保存在 `~/.prime/agent/sessions/` 下：

```bash
prime-agent -c                  # 继续最近的会话
prime-agent -r [path|id]        # 浏览会话或打开特定会话
```

在 Prime Agent 内部，使用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 管理会话。持久会话在工作进程中运行，因此关闭 TUI 只是从智能体上断开，不一定停止它。使用 `prime-agent agents` 检查或重新挂载到活跃工作。

### 非交互模式

用于一次性提示：

```bash
prime-agent -p "Summarize this codebase"
cat README.md | prime-agent -p "Summarize this text"
prime-agent -p @screenshot.png "What's in this image?"
```

使用 `--mode json` 进行 JSON 事件输出或 `--mode rpc` 进行进程集成。

## 后续步骤

- [使用 Prime Agent](usage.zh-CN.md) - 交互模式、斜杠命令、会话、上下文文件和 CLI 参考。
- [提供商](providers.md) - 认证和模型设置。
- [设置](settings.md) - 全局和项目配置。
- [快捷键](keybindings.md) - 快捷键和自定义。
- [Prime Agent 包](packages.md) - 安装共享扩展、技能、提示和主题。

平台说明：[Windows](windows.md)、[Termux](termux.md)、[tmux](tmux.md)、[终端设置](terminal-setup.md)、[Shell 别名](shell-aliases.md)。

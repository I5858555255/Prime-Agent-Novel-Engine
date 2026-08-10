# 使用 Prime Agent

> 本文件是 [usage.md](usage.md) 的中文翻译。如有不一致之处，以英文原文为准。

本页收集不适合放在快速入门页面上的日常使用细节。

Prime Agent 围绕一个面向模型的工具构建：持久化 IPython 内核。该内核跨轮次保留 Python 状态，并充当文件操作、项目命令、已安装 Python 技能、MCP 支持的技能和递归子智能体的控制环境。TypeScript 宿主仍负责提供商调用、会话状态、工具执行、调度和子智能体生命周期。

## 交互模式

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面有四个主要区域：

- **启动头部** - 简洁的品牌和运行时摘要；`--verbose` 还会列出已加载的上下文文件、提示模板、技能和扩展。
- **消息** - 用户消息、助手响应、工具调用、工具结果、通知、错误和扩展 UI。
- **编辑器** - 你输入的地方。
- **页脚** - 默认为空；使用 `/usage` 查看 Token、费用和上下文详情。

编辑器可以被内置 UI（如 `/settings`）或自定义扩展 UI 临时替换。

### 编辑器功能

| 功能 | 操作方式 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter，或 Windows Terminal 上的 Ctrl+Enter |
| 图片 | Ctrl+V 粘贴，Windows 上为 Alt+V，或拖入终端 |
| Shell 命令 | `!command` 运行并将输出发送给模型 |
| 隐藏 Shell 命令 | `!!command` 运行但不将输出发送给模型 |
| 外部编辑器 | Ctrl+G 打开 `$VISUAL` 或 `$EDITOR` |

所有快捷键和自定义请参阅[快捷键](keybindings.md)。

## 斜杠命令

在编辑器中输入 `/` 打开命令补全。扩展可以注册自定义命令，技能可通过 `/skill:name` 使用，提示模板通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`、`/logout` | 管理 OAuth 或 API 密钥凭据 |
| `/model` | 切换模型 |
| `/effort` | 设置推理/思考级别 |
| `/scoped-models` | 启用/禁用用于 Ctrl+P 循环的模型 |
| `/settings` | 思考级别、主题、消息传递、传输方式 |
| `/resume` | 从之前的会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话文件、ID 和消息计数 |
| `/traces [status\|on\|off\|preview\|upload-current\|upload-all\|login]` | 预览、上传或管理可选的追踪共享 |
| `/usage`、`/context` | 显示父智能体和子智能体的上下文、Token 和费用明细 |
| `/tree` | 跳转到会话中的任意点并从那里继续 |
| `/fork` | 从之前的用户消息创建新会话 |
| `/clone` | 将当前活跃分支复制到新会话 |
| `/compact [prompt]` | 手动压缩上下文，可带自定义指令 |
| `/refine [instructions]` | 改进或回滚会话支持的框架状态 |
| `/copy` | 复制最后一条助手消息到剪贴板 |
| `/btw <question>`、`/side <question>` | 提出内联旁路问题而不将其添加到会话；回复继续旁路对话，esc 返回 |
| `/export [file]` | 将会话导出为 HTML |
| `/share` | 上传为私有 GitHub gist 并带可共享的 HTML 链接 |
| `/reload` | 重新加载快捷键、扩展、技能、提示和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 Prime Agent |

## 消息队列

你可以在智能体仍在工作时提交消息：

- **Enter** 排队一条引导消息，在当前助手轮次执行完工具调用后传递。
- **Alt+Enter** 排队一条后续消息，在智能体完成所有工作后传递。
- **Ctrl+C** 中断当前操作并短暂显示退出提示；在提示可见时再次按下则退出。
- **Escape** 清空输入栏而不中断智能体。
- **Alt+Up** 将排队的消息取回编辑器。

在 Windows Terminal 上，Alt+Enter 默认是全屏。如果你希望 Prime Agent 接收该快捷键，请按[终端设置](terminal-setup.md)中的说明重新映射。

在[设置](settings.md)中通过 `steeringMode` 和 `followUpMode` 配置传递方式。

## 会话

会话自动保存为 `~/.prime/agent/sessions/` 下的扁平 JSONL 文件。每个会话头部记录其工作目录，会话选择器使用它进行项目范围视图。

```bash
prime-agent -c                  # 继续最近的会话
prime-agent -r [path|id]        # 浏览会话或直接恢复一个
prime-agent --no-session        # 临时模式；不保存
prime-agent --fork <path|id>    # 将会话分叉为新会话文件
```

有用的会话命令：

- `/session` 显示当前会话文件和 ID。
- `/usage` 显示 Token、费用和上下文使用情况。
- `/tree` 导航文件内会话树，并可摘要被放弃的分支。
- `/fork` 从更早的用户消息创建新会话。
- `/clone` 将当前活跃分支复制到新会话文件。
- `/compact` 摘要旧消息以释放上下文。

详情请参阅[会话](sessions.md)和[压缩](compaction.md)。

## 智能体与递归子智能体

正常的交互会话是由隔离工作进程支持的持久智能体。关闭 TUI 只断开客户端；使用 `prime-agent agents`、`prime-agent list` 或 `prime-agent attach <agent>` 查找并重新挂载到运行中的工作。`prime-agent stop <agent>` 停止一个根智能体，而 `prime-agent shutdown` 停止所有工作进程和本地监督器。

在会话内，模型可以通过 IPython 中已有的 `rlm` 可调用对象进行委派：

```python
# 生成独立子智能体。每次调用在准入时返回子句柄，
# 而非子智能体的答案。
review = await rlm(
    "Review authentication and reply to the parent with findings.",
    name="auth-reviewer",
)
tests = await rlm("Find missing regression tests and reply to the parent.", name="test-reviewer")
docs = await rlm("Find stale public documentation and reply to the parent.", name="docs-reviewer")

# 子智能体从自己的会话回复：
# await agent_message.send(message, receiver_role="parent")
# 它们的回复作为普通智能体消息到达这里。

# 恢复句柄并向保留的子智能体发送后续消息。
children = await rlm.list_subagents()
await agent_message.send(
    "Also check authorization boundaries.",
    receiver_role="child",
    receiver_name=review.name,
)
```

子智能体继承父模型，除非用户请求另一个模型。它们作为 TypeScript `AgentSession` 实例在同一根工作进程下运行，可以使用相同的提供商、工具、技能、会话存储和调度系统。请参阅 [RLM 运行时架构](rlm-runtime.md)。

## 上下文文件

Prime Agent 在启动时从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- `~/.prime/agent/AGENTS.md` 用于全局指令
- 父目录，从当前工作目录向上遍历
- 当前目录

使用上下文文件来定义项目约定、命令、安全规则和偏好。使用 `--no-context-files` 或 `-nc` 禁用加载。

### 系统提示文件

用以下文件替换默认系统提示：

- `.prime/agent/SYSTEM.md` 用于项目
- `~/.prime/agent/SYSTEM.md` 用于全局

在任一位置使用 `APPEND_SYSTEM.md` 追加到默认提示而不替换它。

## 导出和共享会话

使用 `/export [file]` 将会话写入 HTML。

使用 `/share` 上传私有 GitHub gist 并带可共享的 HTML 链接。

## CLI 参考

```bash
prime-agent [options] [@files...] [messages...]
```

### Shell 命令

```bash
prime-agent agents
prime-agent list [--all]
prime-agent attach <agent>
prime-agent stop <agent>
prime-agent rename <agent> <name>
prime-agent send <agent> <message>
prime-agent schedule <list|add|cancel>
prime-agent status
prime-agent doctor [--fix]
prime-agent shutdown [--force]

prime-agent package install <source> [--local]
prime-agent package remove <source> [--local]
prime-agent package list
prime-agent package update [source]
prime-agent update [--force]
prime-agent config
```

包源和安全说明请参阅 [Prime Agent 包](packages.md)。

### 模式

| 标志 | 说明 |
|------|------|
| 默认 | 交互模式 |
| `-p`、`--print` | 打印响应并退出 |
| `--mode json` | 将所有事件输出为 JSON 行；见 [JSON 模式](json.md) |
| `--mode rpc` | 通过 stdin/stdout 的 RPC 模式；见 [RPC 模式](rpc.md) |

在打印模式下，Prime Agent 还会读取管道输入的 stdin 并将其合并到初始提示中：

```bash
cat README.md | prime-agent -p "Summarize this text"
```

### 模型选项

| 选项 | 说明 |
|--------|------|
| `--provider <name>` | 提供商，如 `anthropic`、`openai` 或 `google` |
| `--model <pattern>` | 模型模式或 ID；支持 `provider/id` 和可选的 `:<thinking>` |
| `--api-key <key>` | API 密钥，覆盖环境变量 |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `--models <patterns>` | 逗号分隔的 Ctrl+P 循环模式 |

使用 `prime-agent model list [search]` 列出可用模型。

### 会话选项

| 选项 | 说明 |
|--------|------|
| `-c`、`--continue` | 继续最近的会话 |
| `-r`、`--resume [path\|id]` | 浏览并选择会话，或恢复特定会话文件或部分 UUID |
| `--fork <path\|id>` | 将会话文件或部分 UUID 分叉为新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式；不保存 |

使用 `prime-agent session export <file> [output]` 将会话导出为 HTML。

### 工具选项

| 选项 | 说明 |
|--------|------|
| `--tools <list>`、`-t <list>` | 允许列表特定内置、扩展和自定义工具 |
| `--no-builtin-tools`、`-nbt` | 禁用内置工具但保持扩展/自定义工具启用 |
| `--no-tools`、`-nt` | 禁用所有工具 |

内置工具：`ipython`。

### 资源选项

| 选项 | 说明 |
|--------|------|
| `-e`、`--extension <source>` | 从路径、npm 或 git 加载扩展；可重复 |
| `--no-extensions`、`-ne` | 禁用扩展发现 |
| `--skill <path>` | 加载技能；可重复 |
| `--no-skills`、`-ns` | 禁用技能发现 |
| `--prompt-template <path>` | 加载提示模板；可重复 |
| `--no-prompt-templates`、`-np` | 禁用提示模板发现 |
| `--theme <path>` | 加载主题；可重复 |
| `--no-themes` | 禁用主题发现 |
| `--no-context-files`、`-nc` | 禁用 `AGENTS.md` 和 `CLAUDE.md` 发现 |

将 `--no-*` 与显式标志结合使用，以仅加载你所需的内容，忽略设置。例如：

```bash
prime-agent --no-extensions -e ./my-extension.ts
```

### 自主选项

自主模式是用于无人值守工作的宿主策略。它默认禁用。`--autonomous` 启用它，提供任何 `--autonomous-*` 子选项也会启用它。宿主以全新的延续、轮次、Token 和经过时间计数器启动每个启用的运行。

| 选项 | 行为、单位和默认值 |
|--------|------------------------------|
| `--autonomous` | 启用自主延续。无门控时，宿主持续请求工作直到某个限制阻止下一次延续。 |
| `--autonomous-gate <command>` | 添加必须在运行完成前通过的 Shell 命令。可重复的命令按 CLI 顺序运行；默认无门控。 |
| `--autonomous-gate-retries <n>` | 设置每个门控的重试限制。默认：`3`。失败的门控在其记录的尝试次数不超过此值时可继续；下一次失败尝试将耗尽门控。 |
| `--autonomous-gate-timeout-ms <n>` | 设置每个门控进程的超时时间（毫秒）。默认：`300000`（5 分钟）。超时的门控视为失败并停止其进程树。 |
| `--autonomous-max-continuations <n>` | 设置最大宿主注入后续消息数。默认：`3`。 |
| `--autonomous-max-turns <n>` | 设置自主模式启用时计算的最大助手响应数。默认：`12`。 |
| `--autonomous-max-tokens <n>` | 设置最大累积 Token 数。默认：`80000`；计算包括输入、输出和缓存写入 Token，但不包括缓存读取 Token。 |
| `--autonomous-timeout-ms <n>` | 设置最大自主经过时间（毫秒）。默认：`1800000`（30 分钟）。 |

所有 `<n>` 值必须是正整数：零、负数、分数和非数值会被拒绝。接受值的自主标志需要单独的参数，而非 `--flag=value`。缺少值会被拒绝，后续的长选项不会被当作值消费。重复的数值标志使用其最后一个值；重复 `--autonomous-gate` 会追加另一个门控。

每次助手响应后，配置的门控在评估普通延续限制之前运行。所有门控必须通过才能完成运行。失败的门控向下一次延续提供有界的命令输出，以便智能体修复它；Prime Agent 避免重新运行未更改的失败门控，而是推进其尝试计数。通过的門控即使在已达到延续、轮次、Token 或时间限制的情况下也允许完成。如果门控未通过或没有门控，宿主只能在所有四个限制都低于其配置值时注入另一次延续。限制按以下顺序检查：延续、轮次、Token，然后是经过时间。达到任何一个都会阻止另一次自动延续；这并不意味着任务成功。

例如，以下非交互运行使用本地可用的模型配置，跳过启动网络操作，并限定每个自主预算，同时要求项目检查通过：

```bash
prime-agent -p \
  --autonomous \
  --autonomous-gate "npm run check" \
  --autonomous-gate-retries 2 \
  --autonomous-gate-timeout-ms 300000 \
  --autonomous-max-continuations 3 \
  --autonomous-max-turns 12 \
  --autonomous-max-tokens 80000 \
  --autonomous-timeout-ms 1800000 \
  --model openai/gpt-5.1-codex \
  --offline \
  --thinking high \
  "Fix the failing check and report the verified result."
```

`--offline` 禁用启动网络操作；它不提供模型凭据，也不使提供商推理离线。选择已为本地环境配置的模型。

目标与自主模式分开：`--goal <objective>` 仅在没有现有目标状态的新根会话中启动持久目标，而自主模式决定宿主是否应注入另一次延续。`--goal-token-budget <n>` 是该初始目标的正整数 Token 预算，需要 `--goal`。

### 其他选项

| 选项 | 说明 |
|--------|------|
| `--cwd <dir>` | 为会话使用特定工作目录 |
| `--system-prompt <text>` | 替换默认提示；上下文文件和技能仍会追加 |
| `--append-system-prompt <text>` | 追加到系统提示 |
| `--verbose` | 强制详细启动 |
| `--offline` | 禁用启动网络操作 |
| `-h`、`--help` | 显示帮助 |
| `-v`、`--version` | 显示版本 |
| `--` | 结束选项解析，将所有后续参数视为消息 |

### 文件参数

在文件前加 `@` 将其包含在消息中：

```bash
prime-agent @prompt.md "Answer this"
prime-agent -p @screenshot.png "What's in this image?"
prime-agent @code.ts @test.ts "Review these files"
```

### 示例

```bash
# 带初始提示的交互模式
prime-agent "List all .ts files in src/"

# 非交互模式
prime-agent -p "Summarize this codebase"

# 带管道 stdin 的非交互模式
cat README.md | prime-agent -p "Summarize this text"

# 不同模型
prime-agent --provider openai --model gpt-4o "Help me refactor"

# 带提供商前缀的模型
prime-agent --model openai/gpt-4o "Help me refactor"

# 带思考级别简写的模型
prime-agent --model sonnet:high "Solve this complex problem"

# 限制模型循环
prime-agent --models "claude-*,gpt-4o"

# 仅限内置 IPython 工具
prime-agent --tools ipython -p "Review the code"
```

### 环境变量

| 变量 | 说明 |
|----------|------|
| `PRIME_AGENT_CODING_AGENT_DIR` | 覆盖配置目录；默认为 `~/.prime/agent` |
| `PRIME_AGENT_SESSION_DIR` | 覆盖会话存储目录；被 `--session-dir` 覆盖 |
| `PRIME_AGENT_CODING_AGENT_SESSION_DIR` | `PRIME_AGENT_SESSION_DIR` 的旧别名 |
| `PI_PACKAGE_DIR` | 覆盖包目录，适用于 Nix/Guix 存储路径 |
| `PI_OFFLINE` | 禁用启动网络操作，包括更新检查和包更新检查 |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的 Prime Agent 版本更新检查。这会阻止发布清单请求 |
| `PRIME_AGENT_DOWNLOAD_BASE_URL` | 覆盖 Prime Agent 发布清单和 tarball 基础 URL |
| `PI_CACHE_RETENTION` | 设置为 `long` 以在支持的提供商上使用扩展提示缓存 |
| `PRIME_API_KEY` | Prime 推理 API 密钥；当具有 `agent_traces` 范围时也用于追踪共享 |
| `PRIME_AGENT_TRACES_API_KEY` | 仅用于可选追踪共享的 Prime API 密钥 |
| `PRIME_AGENT_TRACES_BASE_URL` | 覆盖 Prime Agent 追踪上传 API 基础 URL |
| `PRIME_AGENT_KERNEL_PYTHON` | 使用带有 `ipykernel` 的现有 Python 环境，而非引导 `~/.prime/agent/kernel-venv` |
| `VISUAL`、`EDITOR` | Ctrl+G 的外部编辑器 |

其余 `PI_*` 变量是当前运行时仍读取的兼容名称。它们不会更改应用名称、命令或默认的 `~/.prime/agent` 配置路径。

## 设计原则

Prime Agent 保持面向模型的工具面小而精，同时使 IPython 运行时强大且可组合。内置的 `ipython` 工具提供持久状态、项目命令执行、Python 技能、MCP 支持的集成和原生 `rlm` 委派 API，而无需将每项能力作为单独的模型工具呈现。

递归子智能体是核心能力，而非可选扩展。TypeScript 宿主拥有每个父智能体和子智能体循环，因此递归使用相同的提供商、会话、工具、技能、调度、使用量核算和恢复基础设施。Python `rlm` 包是通往宿主的薄桥接，而非单独的智能体实现。

扩展、技能、提示模板、主题和 Prime Agent 包仍然是主要的自定义面。它们可以在内置运行时周围添加项目特定的工作流、自定义工具和 UI、权限策略、提供商集成和编排模式。

Prime Agent 保留了 pi-mono 上游血统的 MIT 归属，但上游 Pi 产品声明和限制不描述当前的 Prime Agent 架构。

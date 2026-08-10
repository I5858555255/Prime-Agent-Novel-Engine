# 开发规则（中文翻译）

> 本文件是 [AGENTS.md](AGENTS.md) 的中文翻译。如有不一致之处，以英文原文为准。

## 对话风格

- 不写废话或欢快的填充文本
- 回答简短精炼
- 提交信息、Issue、PR 评论和代码中不使用表情符号
- 仅使用技术性语言，友善但直接（例如用 "Thanks @user" 而非 "Thanks so much @user!"）

## 代码质量

- 在进行大范围修改前、编辑尚未完整检查的文件前，以及用户要求调查或审计时，务必完整阅读文件。不要仅依赖搜索片段进行大范围修改。
- 代码注释不要过于冗长。仅在存在严重歧义时才写注释。
- 除非绝对必要，不使用 `any` 类型。
- 查看 `node_modules` 中的外部 API 类型定义，而不是猜测。
- **绝不使用内联导入** - 不用 `await import("./foo.js")`，不用 `import("pkg").Type` 作为类型，不用动态导入类型。始终使用标准的顶层导入。
- 绝不为了修复过时依赖导致的类型错误而删除或降级代码；应升级依赖。
- 在删除看似有意的函数功能或代码前，务必先询问。
- 除非用户明确要求，不保留向后兼容性。
- 绝不硬编码按键检查，例如 `matchesKey(keyData, "ctrl+x")`。所有快捷键必须可配置。将默认值添加到匹配对象中（`DEFAULT_EDITOR_KEYBINDINGS` 或 `DEFAULT_APP_KEYBINDINGS`）。
- 绝不直接修改 `packages/ai/src/models.generated.ts`。应更新 `packages/ai/scripts/generate-models.ts`。

## 命令

- 代码变更后（非文档变更）：运行 `npm run check`（获取完整输出，不截断）。提交前修复所有错误、警告和信息提示。
- 注意：`npm run check` 不运行测试。
- 绝不运行：`npm run dev`、`npm run build`、`npm test`。
- 仅在用户指示时运行特定测试：`npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`。
- 从包根目录运行测试，而非仓库根目录。
- 如果创建或修改了测试文件，必须运行该测试文件并迭代直到通过。
- 编写测试时，运行它们，识别测试或实现中的问题，并迭代修复。
- 对于 `packages/coding-agent/test/suite/`，使用 `test/suite/harness.ts` 和模拟提供商。不要使用真实提供商 API、真实 API 密钥或付费 Token。
- 将特定 Issue 的回归测试放在 `packages/coding-agent/test/suite/regressions/` 下，命名为 `<issue-number>-<short-slug>.test.ts`。

## 守护进程协议变更

- 将每个守护进程命令、事件和响应结构的变更分类为向后兼容、能力门控或不兼容。
- 在协商的服务器能力后面添加可选功能。客户端必须在发送命令或依赖事件之前检查该能力。
- 对于不兼容变更或启动开始需要旧守护进程无法提供的行为时，提升 `DAEMON_PROTOCOL_VERSION`。
- 对每次线路变更更新 `DAEMON_SCHEMA_REVISION`、命令/事件兼容性映射，以及新客户端/旧守护进程和旧客户端/新守护进程测试。
- 可选的守护进程元数据和 UI 功能必须在本地优雅降级。它们不得阻止智能体、会话挂载或交互式启动。
- 绝不在没有协议或能力门控的情况下将新的守护进程命令作为启动的一部分。

## 依赖

- 所有依赖更新适用 7 天最低发布期限：`.npmrc` 设置 `min-release-age=7`，`.github/dependabot.yml` 使用匹配的 `cooldown`。常规更新绝不绕过此规则。
- 强制执行需要 npm >= 11.10；旧版 npm 会静默忽略该设置，因此更新依赖时请使用当前版本的 npm。
- 对于 7 天内的紧急安全补丁，显式覆盖：`npm install --min-release-age=0 <pkg>`。

## GitHub 工作流

创建 Issue 时：

- 添加 `pkg:*` 标签以指示受影响的包。
  - 可用标签：`pkg:agent`、`pkg:ai`、`pkg:coding-agent`、`pkg:tui`
- 如果 Issue 跨多个包，添加所有相关标签。

发布 Issue/PR 评论时：

- 将完整评论写入临时文件，使用 `gh issue comment --body-file` 或 `gh pr comment --body-file`。
- 绝不在 Shell 命令中通过 `--body` 直接传递多行 Markdown。
- 发布前预览确切的评论文本。
- 除非用户明确要求多条评论，否则仅发布一条最终评论。
- 如果评论格式错误，立即删除，然后发布一条修正后的评论。
- 保持评论简洁、技术化，使用用户的语气。

通过提交关闭 Issue 时：

- 在提交信息中包含 `fixes #<number>` 或 `closes #<number>`。
- 这会在提交合并时自动关闭 Issue。

## PR 工作流

- 先分析 PR，不要先拉取到本地。
- 如果用户批准：创建功能分支，拉取 PR，在 main 上变基，应用调整，提交，合并到 main，推送，关闭 PR，并以用户的语气留下评论。
- 我们在功能分支上工作，直到一切符合用户要求。绝不自行合并 PR。

## 在 tmux 中测试 TUI

要在受控终端环境中测试 Prime Agent 的 TUI：

```bash
# 创建具有特定尺寸的 tmux 会话
tmux new-session -d -s prime-agent-test -x 80 -y 24

# 从源码启动 Prime Agent
tmux send-keys -t prime-agent-test "cd /Users/kevin/pi/prime-agent && ./prime-agent.sh" Enter

# 等待启动，然后捕获输出
sleep 3 && tmux capture-pane -t prime-agent-test -p

# 发送输入
tmux send-keys -t prime-agent-test "your prompt here" Enter

# 发送特殊按键
tmux send-keys -t prime-agent-test Escape
tmux send-keys -t prime-agent-test C-o  # ctrl+o

# 清理
tmux kill-session -t prime-agent-test
```

你自己通常也运行在 tmux 会话中，因此杀死 tmux 会话时要小心。许多其他进程可能运行在不同的 tmux 会话中。

## 变更日志

位置：`packages/*/CHANGELOG.md`（每个包有自己的变更日志）

### 格式

`## [Unreleased]` 下的扁平纯文本列表。不使用 `### Added` / `### Changed` / `### Fixed` / `### Removed` 子部分 - 每个变更仅一条，以过去式动词开头的短句（Added、Changed、Fixed、Removed）。每条保持一行；描述用户可见的变更，而非实现细节。

格式正确的 `[Unreleased]` 示例：

```markdown
## [Unreleased]

- Added `/effort` to set the reasoning level, with autocomplete for the levels the current model supports.
- Changed `prime-agent` to open a new chat by default instead of resuming the previous session.
- Fixed onboarding showing no models after entering a provider key.
- Removed the interactive `!` / `!!` bash shortcuts; use IPython instead.
```

### 规则

- 先阅读完整的 `[Unreleased]` 部分，以免重复已有条目。
- 新条目始终放在 `## [Unreleased]` 下。
- 绝不修改已发布的版本部分（例如 `## [0.2.1]`）- 每个部分一旦发布即不可变。

### 归属

- **内部变更（来自 Issue）**：`Fixed foo bar ([#123](https://github.com/PrimeIntellect-ai/prime-agent/issues/123))`
- **外部贡献**：`Added feature X ([#456](https://github.com/PrimeIntellect-ai/prime-agent/pull/456) by [@username](https://github.com/username))`

## 添加新的 LLM 提供商（packages/ai）

添加新提供商需要跨多个文件进行修改：

### 1. 核心类型（`packages/ai/src/types.ts`）

- 将 API 标识符添加到 `Api` 类型联合中（例如 `"bedrock-converse-stream"`）。
- 创建扩展 `StreamOptions` 的选项接口。
- 添加到 `ApiOptionsMap` 的映射。
- 将提供商名称添加到 `KnownProvider` 类型联合中。

### 2. 提供商实现（`packages/ai/src/providers/`）

创建提供商文件，导出：

- `stream<Provider>()` 函数，返回 `AssistantMessageEventStream`
- `streamSimple<Provider>()` 用于 `SimpleStreamOptions` 映射
- 提供商特定的选项接口
- 消息/工具转换函数
- 响应解析，发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

### 3. 提供商导出和惰性注册

- 在 `packages/ai/package.json` 中添加包子路径导出，指向 `./dist/providers/<provider>.js`。
- 在 `packages/ai/src/index.ts` 中添加 `export type` 重导出，用于应从根入口保持可用的提供商选项类型。
- 在 `packages/ai/src/providers/register-builtins.ts` 中通过惰性加载器包装注册提供商，不要在那里静态导入提供商实现模块。
- 在 `packages/ai/src/env-api-keys.ts` 中添加凭据检测。

### 4. 模型生成（`packages/ai/scripts/generate-models.ts`）

- 添加从提供商源获取/解析模型的逻辑。
- 映射到标准化的 `Model` 接口。

### 5. 测试（`packages/ai/test/`）

- 始终将提供商添加到 `stream.test.ts` 中，至少包含一个代表性模型，即使它复用现有的 API 实现（例如 `openai-completions`）。
- 在适用的更广泛提供商矩阵中添加该提供商：`tokens.test.ts`、`abort.test.ts`、`empty.test.ts`、`context-overflow.test.ts`、`image-limits.test.ts`、`unicode-surrogate.test.ts`、`tool-call-without-result.test.ts`、`image-tool-result.test.ts`、`total-tokens.test.ts`、`cross-provider-handoff.test.ts`。
- 对于 `cross-provider-handoff.test.ts`，至少添加一个提供商/模型对。如果提供商暴露多个模型系列（例如 GPT 和 Claude），每个系列至少添加一对。
- 对于非标准认证，创建工具（例如 `bedrock-utils.ts`）进行凭据检测。

### 6. 编码智能体（`packages/coding-agent/`）

- `src/core/model-resolver.ts`：将默认模型 ID 添加到 `defaultModelPerProvider`。
- `src/core/provider-display-names.ts`：添加 API 密钥登录显示名称，以便 `/login` 和相关 UI 为内置 API 密钥认证显示该提供商。
- `src/cli/args.ts`：添加环境变量文档。
- `README.md`：添加提供商设置说明。
- `docs/providers.md`：添加设置说明、环境变量和 `auth.json` 键。

### 7. 文档

- `packages/ai/README.md`：添加到提供商表，记录选项/认证，添加环境变量。
- `packages/ai/CHANGELOG.md`：在 `## [Unreleased]` 下添加条目。

## 发布

**锁步版本控制**：所有包始终共享相同的版本号。每次发布都同时更新所有包。

**版本语义**（无大版本发布）：

- `patch`：Bug 修复和新功能。
- `minor`：API 破坏性变更。

### 步骤

1. **更新变更日志**：确保自上次发布以来的所有变更都已记录在每个受影响包的 CHANGELOG.md 的 `[Unreleased]` 部分中。

2. **运行发布脚本**：
   ```bash
   npm run release:patch    # 修复和新增
   npm run release:minor    # API 破坏性变更
   ```

脚本处理：版本号提升、变更日志定稿、提交、打标签、发布，以及添加新的 `[Unreleased]` 部分。

## **关键** 并行智能体的 Git 规则 **关键**

多个智能体可能同时在同一工作树中操作不同的文件。你必须遵循以下规则：

### 提交

- **仅提交你在本次会话中修改的文件**。
- 当有相关 Issue 或 PR 时，始终在提交信息中包含 `fixes #<number>` 或 `closes #<number>`。
- 绝不使用 `git add -A` 或 `git add .` - 这些会扫入其他智能体的更改。
- 始终使用 `git add <specific-file-paths>`，仅列出你修改的文件。
- 提交前运行 `git status` 并验证你仅暂存了你的文件。
- 跟踪你在会话期间创建/修改/删除了哪些文件。
- 将 `packages/ai/src/models.generated.ts` 包含在提交中始终是可以的，只要与你想提交的实际文件一起即可。

### 禁止的 Git 操作

这些命令可能破坏其他智能体的工作：

- `git reset --hard` - 销毁未提交的更改
- `git checkout .` - 销毁未提交的更改
- `git clean -fd` - 删除未跟踪的文件
- `git stash` - 暂存所有更改，包括其他智能体的工作
- `git add -A` / `git add .` - 暂存其他智能体未提交的工作
- `git commit --no-verify` - 绕过必需的检查，绝不允许

### 安全工作流

```bash
# 1. 先检查状态
git status

# 2. 仅添加你的特定文件
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. 提交
git commit -m "fix(ai): description"

# 4. 推送（如有需要 pull --rebase，但绝不 reset/checkout）
git pull --rebase && git push
```

### 如果发生变基冲突

- 仅在你的文件中解决冲突。
- 如果冲突在你未修改的文件中，中止并询问用户。
- 绝不强制推送。

### 用户覆盖

如果用户指令与此处设定的规则冲突，请确认他们是否要覆盖规则。只有在确认后才执行其指令。

# Settings

Prime Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.prime/agent/settings.json` | Global (all projects) |
| `.prime/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., "anthropic", "openai") |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"medium"` | Default thinking/reasoning level (enum: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`) |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 16384,
    "low": 16384,
    "medium": 16384,
    "high": 16384
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name ("dark", "light", or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `treeFilterMode` | string | `"user-only"` | Default filter for /tree: "default", "no-tools", "user-only", "labeled-only", "all" (enum: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"`) |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) (min: 0, max: 3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) (min: 3, max: 20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Telemetry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `true` | Send pseudonymous aggregate usage and performance events |

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.agentCallable` | boolean | `true` | Expose the compact skill so the model can request compaction |

### Auto Refine

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autoRefine.enabled` | boolean | `true` | Enable automatic self-refinement |
| `autoRefine.turnInterval` | number | `25` | Number of assistant turns between refinement passes |
| `autoRefine.compact` | boolean | `true` | Compact the session before refinement |
| `autoRefine.cooldownMs` | number | `1200000` | Cooldown between refinements in milliseconds (20 minutes) |

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on /tree navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: "all" or "one-at-a-time" (enum: `"all"`, `"one-at-a-time"`) |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: "all" or "one-at-a-time" (enum: `"all"`, `"one-at-a-time"`) |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: "sse", "websocket", or "auto" (enum: `"sse"`, `"websocket"`, `"auto"`) |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.showTerminalProgress` | boolean | `false` | OSC 9;4 terminal progress indicators |
| `terminal.fullscreen` | boolean | `true` | Alternate-screen rendering with scrollable transcript |
| `terminal.fullscreenMouse` | boolean | `true` | Wheel scrolling in fullscreen; disable if it breaks selection |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., "shopt -s expand_aliases") |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., ["mise", "exec", "node@20", "--", "npm"]) |

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | string \| number | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; "off" disables both. Global-only setting. |

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus ~. |

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as --models CLI flag) |

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | string[] | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as /skill:name commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with prime-agent |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in websearch skill |

### Agent Traces

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentTraces.enabled` | boolean | `false` | Enable agent traces for debugging |

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": [
    "claude-*",
    "gpt-4o"
  ],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": [
    "pi-skills"
  ]
}
```

## Project Overrides

Project settings (`.prime/agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.prime/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384
  }
}

// .prime/agent/settings.json (project)
{
  "compaction": {
    "reserveTokens": 8192
  }
}

// Result
{
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 8192
  }
}
```
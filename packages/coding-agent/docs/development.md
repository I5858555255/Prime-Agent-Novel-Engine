# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm install
npm run build
```

Run from source:

```bash
/path/to/prime-agent/prime-agent-test.sh
```

The script can be run from any directory. Prime Agent keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "primeAgentConfig": {
    "name": "prime-agent",
    "configDir": ".prime/agent"
  }
}
```

Change `name`, `configDir`, and the `bin` field for your fork. This affects the CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.prime/agent/prime-agent-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```

# Contributing to Prime Agent

Prime Agent is a hard fork of pi-mono. New development happens in this repository; contributions should target Prime Agent's current architecture and behavior rather than the upstream project.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Keep changes focused. Discuss large user-facing or architectural changes in an issue first.
- Never include API keys, OAuth tokens, session logs, prompts containing private data, or generated credentials in an issue, test fixture, or commit.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development Setup

Prime Agent requires Node.js 22.8 or newer. Install dependencies and run the source launcher:

```bash
npm ci
./prime-agent.sh
```

User configuration is stored under `~/.prime/agent/`. Project-local resources are stored under `.prime/agent/`. Avoid using real user configuration or credentials in tests.

## Making Changes

- Follow the existing TypeScript style and package boundaries.
- Do not edit `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` and regenerate it.
- Keep keybindings configurable through the default keybinding maps.
- Treat extensions, skills, model providers, the IPython kernel, and daemon processes as explicit trust boundaries.
- For daemon wire changes, update the schema revision, compatibility maps, capability or protocol gates, and both compatibility directions.
- Add user-visible changes to the affected package's `CHANGELOG.md` under `## [Unreleased]`.

After code changes, run the repository checks:

```bash
npm run check
```

This command does not run tests. Run only the test files relevant to your change, from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Tests under `packages/coding-agent/test/suite/` must use the local harness and faux provider. They must not call real model APIs or consume paid tokens.

## Pull Requests

- Explain the user-visible behavior and why the change belongs in Prime Agent.
- Describe verification performed and any testing not performed.
- Call out changes to persisted data, credentials, daemon protocol, kernel execution, extension loading, or network behavior.
- Link related issues with `fixes #<number>` or `closes #<number>` when appropriate.
- Keep generated files and dependency lock changes scoped to the change.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).

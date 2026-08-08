# Packed TUI Quick Start Implementation Plan

## Task 1: Add the package-boundary regression

- Add `packages/tui/test/952-packed-quick-start.test.ts` with isolated command, package staging, dependency-closure, README extraction, and child-process helpers.
- Build and pack the TUI into temporary directories.
- Extract and compile the exact packed Quick Start in a clean consumer project.
- Run the compiled example with controlled stdin/stdout, wait for its first render, send Ctrl+C, and assert a clean exit.
- Run the single test and confirm it fails on the repository-relative theme import before the documentation fix.

## Task 2: Make the Quick Start self-contained

- Replace the test-only theme import with an inline identity `EditorTheme` covering every required editor and select-list style.
- Keep the package name, TUI behavior, and public exports unchanged.
- Run the single regression and iterate until it passes.

## Task 3: Document and validate the fix

- Add one attributed TUI `[Unreleased]` changelog bullet.
- Run `node --test --import tsx test/952-packed-quick-start.test.ts` from `packages/tui`.
- Run `npm run check` from the repository root and resolve every reported problem.
- Inspect the final diff for issue-only scope and package-boundary coverage.

## Task 4: Review and publish

- Request an independent review against issue #952 and the approved design.
- Verify and address each technically applicable finding, rerunning affected checks.
- Stage only the issue #952 files, commit with `fixes #952`, push `agent/952-packed-tui-quick-start` to `fettpl/prime-agent`, and open a draft PR to `PrimeIntellect-ai/prime-agent:main`.
- Leave the PR draft and do not tag maintainers or merge.

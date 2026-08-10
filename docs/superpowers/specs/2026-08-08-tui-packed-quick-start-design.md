# Packed TUI Quick Start Design

## Context

The first `packages/tui/README.md` example imports `./test/test-themes.ts`. The TUI package publishes `dist/**/*` and `README.md`, so that repository-only test module is absent from a packed artifact. A consumer copying the documented example into a clean project cannot resolve the import.

## Scope

Make the existing Quick Start self-contained without adding a public theme API or changing TUI runtime behavior. Verify the exact documentation sample through the same package boundary a consumer uses.

## Design

The Quick Start will define a complete minimal `EditorTheme` value inline. Its style functions return their input unchanged. This keeps the example dependency-free, demonstrates the required `Editor` contract, and avoids making the generic TUI primitives package maintain a visual default that belongs to the coding-agent theme layer.

No production export, package dependency, or package-name migration is part of this change.

## Package-Contract Regression

Add `packages/tui/test/952-packed-quick-start.test.ts`. The regression will:

1. Compile the TUI package into an isolated staging directory.
2. Pack the staged package with an isolated npm cache and extract it into a clean consumer project as `node_modules/prime-agent-tui`.
3. Stage only the dependencies declared by the packed manifest, plus Node declarations needed by the consumer compile.
4. Extract the exact first TypeScript block beneath `## Quick Start` from the packed README.
5. Assert that the sample contains no repository-relative test import.
6. Compile the extracted sample against the packed JavaScript and declarations with NodeNext resolution.
7. Start the compiled sample in a child process with controlled stdin/stdout pipes, wait until its welcome text renders, send Ctrl+C, and require a clean exit.

The child process will have a bounded timeout and will be terminated during cleanup if it does not exit. Temporary package, npm-cache, and consumer files will always be removed.

## Error Handling

Command failures will include stdout and stderr in the test error. README extraction will fail explicitly if the Quick Start heading or TypeScript fence is missing. Runtime smoke failures will include captured terminal output and distinguish startup timeout, non-zero exit, signal exit, and missing render output.

## Documentation and Release Notes

Update the TUI `[Unreleased]` changelog with the user-visible documentation fix and issue attribution.

## Acceptance Criteria

- The Quick Start contains no repository-relative test import.
- The example defines every required `EditorTheme` and `SelectListTheme` field inline.
- The exact packed README example compiles in a clean consumer project.
- The compiled example renders, accepts Ctrl+C through the documented input listener, stops the TUI, and exits successfully.
- The TUI package's existing checks remain clean.

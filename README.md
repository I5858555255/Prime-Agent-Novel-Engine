# Prime Agent

Prime Agent is a hard fork of [pi](https://github.com/badlogic/pi-mono) rebuilt around an RLM-native coding and research harness. The TypeScript host keeps pi's terminal UI, provider layer, sessions, and extension machinery, while the model-facing runtime is centered on a persistent IPython kernel and recursive subagents.

## Install

Install the latest stable Prime Agent release:

```sh
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

The installer downloads the published release tarball from R2, verifies its checksum, installs the `prime-agent` command with npm, and offers to install standalone Node.js if Node.js 20.6.0 or newer is not available.

Start Prime Agent:

```sh
prime-agent
```

On first run, authenticate with `/login`.

To update, rerun the install command. Releases are created from the root `package.json` version when changes merge to `main`; if the matching Git tag already exists, the release workflow skips publishing.

## Architecture

Prime Agent keeps the core pieces that make pi a strong terminal agent: the TypeScript CLI, custom TUI renderer, model provider layer, session tree, slash commands, and extension/resource system. The main change is the model-facing runtime: instead of a large set of file and shell tools, the agent is centered on a persistent Python kernel.

```text
                         +----------------------+
                         |      prime-agent     |
                         |     typescript cli   |
                         +----------+-----------+
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
        v                           v                           v
+---------------+           +---------------+           +---------------+
|    pi-tui     |           | agent session |           |    pi-ai      |
| terminal ui   |           | loop + events |           | model clients |
+-------+-------+           +-------+-------+           +-------+-------+
        |                           |                           |
        |                           |                           v
        |                           |                  +----------------+
        |                           |                  | rlm-1 or       |
        |                           |                  | bootstrap llm  |
        |                           |                  +----------------+
        |                           |
        v                           v
+---------------+           +---------------+
| ipython cells |           | jsonl session |
| subagent pane |           | tree + resume |
+---------------+           +---------------+

                            prime agent adds
                                    |
                                    v
                         +----------------------+
                         |     ipython tool     |
                         +----------+-----------+
                                    |
                             jupyter zmq
                                    |
                                    v
                         +----------------------+
                         |   ipython kernel     |
                         | persistent python    |
                         | state across turns   |
                         +----------+-----------+
                                    |
                 +------------------+------------------+
                 |                                     |
                 v                                     v
        +------------------+                 +------------------+
        | prime-agent-     |                 | python skills    |
        | runtime          |                 | prime envs/eval/ |
        | injects rlm      |                 | train/etc.       |
        +--------+---------+                 +------------------+
                 |
                 | await rlm("subtask")
                 v
        +------------------+
        | child agent      |
        | session + kernel |
        +------------------+
```

The key loop is:

1. The model receives a normal chat turn plus the RLM system prompt.
2. Tool use goes through the `ipython` tool, which executes code in a persistent IPython kernel.
3. Python variables, imports, loaded logs, dataframes, and helper functions survive across turns.
4. The injected `rlm` callable lets code spawn recursive child agents with `await rlm("subtask")` or fan out with `asyncio.gather(...)`.
5. Each child gets its own agent session and kernel, then returns an `RLMResult` to the parent kernel.
6. The TUI renders kernel cells and the live child-agent tree while preserving the session history on disk.

The default model-facing tool surface is intentionally small: `ipython` first, with RLM-shaped `bash` and `edit` support available where enabled. Prime platform capabilities are exposed as Python skills inside the kernel instead of as separate LLM tools.

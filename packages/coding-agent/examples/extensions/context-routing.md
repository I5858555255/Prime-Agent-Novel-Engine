# Context routing extension

`context-routing.ts` is a project-local Prime Agent extension example. It is a
routing policy, not a security control: the strict mode intentionally favors
false negatives over false positives and can be bypassed.

## Enable it

```bash
pi -e ./context-routing.ts --context-routing advisory
pi -e ./context-routing.ts --context-routing strict-large-read
pi -e ./context-routing.ts --context-routing advisory --context-routing-fast-reindex=off
```

The available modes are:

- `off`: no prompt guidance and no inspection.
- `advisory`: adds concise per-turn guidance. Use jCodeMunch before opening
  whole source files, use Context Mode for web pages, documentation, logs, and
  large data, and keep edits, tests, builds, and git work in Prime Agent.
- `strict-large-read`: adds the advisory and blocks only high-confidence
  context-expanding IPython cells.

The advisory fast-reindex path is enabled by default. Disable it with:

```bash
pi -e ./context-routing.ts --context-routing-fast-reindex=off
```

The mode can also be changed during a session:

```text
/context-routing off
/context-routing advisory
/context-routing strict-large-read
/context-routing stats
```

## Strict-large-read behavior

The extension parses an IPython `%%bash` header before applying conservative
shell recognition. It blocks:

- raw `curl` stdout and `wget -qO-`/`wget -O -` stdout;
- broad `cat` file dumps when the files are not stat-able as small files; and
- immediately printed unbounded `open(...).read()` or
  `Path(...).read_text()` expressions.

Fallbacks are branch-scoped rather than cell-scoped. An `ImportError` branch is
exempt only when its surrounding range names an integration such as
jCodeMunch, and a `command -v`/`which` `||` branch is exempt only when the
availability check names that integration. A `# context-routing: fallback`
marker exempts the following fallback statement only; reads elsewhere in the
cell are still inspected.

Stdout is considered materialized only when a redirect target is a literal file
path or `/dev/null`. Relative targets are resolved against the inspection cwd,
including `..` traversal. Descriptor targets (`&1`, `&2`, `-`, `/dev/stdout`,
`/dev/stderr`, `/dev/fd/*`, and all `/proc/*` paths) are not safe redirects.
Pipelines are bounded
only when the last relevant `head`/`tail` stage has a numeric bound (for
example `head -5` or `tail -n 5`); `tail -n +1` and `--lines=+1` remain
unbounded.

Python output inspects every read in every printed argument. Direct content,
including `str`, `repr`, f-string interpolation, and unbounded slices, remains
guarded; scalar reducers such as `len`, `hash`, `count`, `sum`, and comparisons
are allowed. Bounded reads, stat-able files of 16 KiB or less, normal
builds/tests/git commands, and writes remain allowed. Unknown shell syntax is
allowed rather than guessed to be a violation.

For an intentional exception, put this as the first non-blank line in the
IPython cell:

```python
# context-routing: bypass
print(open("generated-report.txt").read())
```

The bypass is an explicit routing choice, not an authorization mechanism.

## Telemetry and limitations

`installContextRouting()` accepts an optional telemetry hook and returns live
counters. The `/context-routing stats` command displays the same counters.
Telemetry failures are ignored so instrumentation cannot change routing.

This example does not inspect Prime Agent's central MCP, output, or settings
code. It only observes `tool_call` for the built-in `ipython` tool. Recognition
is deliberately conservative: it is not a shell AST, does not evaluate
variables or aliases, and does not promise to catch every broad read. It also
does not block direct Prime Agent edits, tests, builds, git commands, or writes.

## Fast reindex behavior

After a successful built-in `ipython` tool result with `details.status === "ok"`
and one or more `IpythonToolDetails.diffs`, the extension resolves each diff
path against the session working directory and immediately enqueues a best-effort
`jcodemunch-mcp index-file --no-ai-summaries <absolute-path>` invocation. At
most two invocations run at once, duplicate paths are coalesced, and failures
(including a missing `jcodemunch-mcp`) are ignored. The edit result is never
awaited on this queue.

Only existing regular files are eligible. Deleted paths, directories, generated
paths (`dist`, `build`, `generated`, `*.generated.*`, and similar), and other
non-file paths are skipped. The child process uses no shell, receives ignored
stdio, and gets only a minimal environment; its output and errors are not
returned to the agent. The jCodeMunch watcher remains authoritative and will
catch up when this advisory path is unavailable or disabled.

This example launches the separately installed CLI directly because the
extension event API does not expose the host-managed MCP transport. Deployments
that require host-managed-only sidecars should leave the fast path off; normal
context routing and watcher behavior are unchanged.

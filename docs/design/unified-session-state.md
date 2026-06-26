# Unified Session State & Agents View

## Problem

Session state lives on three uncoordinated taxonomies plus a separate "deferred"
code path. The Agents View only ever sees the daemon-resident subset, on-disk
sessions silently disappear, sorting fights itself, and a half-built deferred
connection duplicates real-session logic. Users report: sessions get lost,
ordering is confusing, you can't tell sessions apart, and search isn't reachable
from the view.

### What exists today

1. **Live status** — `SessionStatus = "user" | "idle" | "tool" | "model" | "active" | "sleep" | "crash"`
   (`daemon-session-list.ts:16`). The live half is derived in
   `activeStatusForSession` (`daemon-session-list.ts:283`); the saved half comes
   from disk.
2. **Saved state** — `AgentConnectionSavedSessionStateStatus = "active" | "sleep" | "crash"`
   (`agent-connection/types.ts:44`). `crash` is defined but never set anywhere.
3. **View section** — `AgentsViewSection = "working" | "needs-input" | "completed"`
   (`agents-view-state.ts:4`), computed by `classifyAgentsViewSession`
   (`agents-view-state.ts:31`).
4. **Deferred path** — `DeferredAgentConnection`
   (`agent-connection/deferred-agent-connection.ts:74`) wraps a not-yet-created
   session, with `created`/`ensure`/`promote`/`defaultState`/`dispose`
   branching on deferred-ness in ~5 places, plus `discardEmptyDaemonSession`
   wiring in `main.ts:1375`.

These don't compose: `user`/`idle`/`tool`/`model` are activity, `active`/`sleep`/`crash`
are lifecycle, the section enum is a third thing, and `messageCount === 0`
("new") is special-cased separately (`agents-view-state.ts:364`).

### Two existing inconsistencies to fix while here

- **Unjudged-idle default disagrees with itself.** The Nemotron parser defaults
  an unsure idle verdict to `needs_input` (`daemon-session-summarizer.ts:140`),
  but the view defaults *unjudged* idle to `completed` (`agents-view-state.ts:38`).
  The unified model picks one rule (below).
- **`shouldShowAgentsViewSession`** returns true only when
  `activeSessionId !== undefined` (`agents-view-state.ts:47`) — i.e. only
  daemon-resident sessions. This is the direct cause of "sessions are lost".

## The model: three orthogonal axes

These are not one enum. They answer three independent questions.

### Axis 1 — Lifecycle (durable, authoritative)

Replaces `active`/`sleep`/`crash` *and* the deferred path.

| State | In Agents View? | Daemon | On disk |
|---|---|---|---|
| `draft` | No | ephemeral | never |
| `live` | Yes | attached | yes |
| `archived` | No (only `/resume` & `prime-agent --resume`) | detached | yes |

- **`draft`** — created via `prime-agent`, no message sent. Lives only in daemon
  memory. **Discarded on close** if no message was ever sent; never written to
  disk. First message sent → transitions to `live` exactly once.
- **`live`** — at least one message sent, not archived.
- **`archived`** — user hit `ctrl+x`. Saved to disk, detached from daemon, and
  invisible everywhere except the resume surfaces. Opening one un-archives it →
  `live`.

`crash` folds away: a crashed session is just `live`; surfacing a crash is an
orthogonal diagnostic badge, not a lifecycle state.

### Axis 2 — Activity (heuristic, authoritative; only meaningful while `live`)

Collapses `user`/`idle`/`tool`/`model` into a confident two-way, carried as a
first-class `SessionActivity = "working" | "idle"` field on `SessionSummary`,
computed once in the daemon rather than recomputed inline.

| State | Meaning |
|---|---|
| `working` | model streaming **or** tool running **or** compacting **or** pending messages queued **or** Nemotron classification in flight |
| `idle` | classification done, agent quiet, user's turn |

Key rule: **classification-in-flight counts as `working`.** A `live` session
leaves `working` only once it is *both* (a) quiet and (b) carrying a semantic
label. This removes the "unknown idle" bucket entirely — the view never observes
an idle session without a label.

Today five sites recompute this distinction with slightly different formulas
(`isSessionBusy` in daemon-launch.ts:138, `discardEmptyDaemonSession` in
main.ts:905, `isSessionWorking` in daemon-session-summarizer.ts:201, follow-up
routing in daemon-mode.ts:475, and `classifyAgentsViewSession`). The named field
gives them one definition to share.

Client attachment is a separate fact (a connection count), not a state. `user`
vs `idle` distinction disappears; both become `idle`.

### Axis 3 — Semantic category (soft, display-only; only exists for `live` + `idle`)

`needs_input | completed`. Sourced from Nemotron. **Never gates behavior, never a
source of truth.** By construction never `unknown` at the moment a session enters
`idle` (because in-flight classification keeps it `working`).

**Stall/failure fallback:** if classification doesn't return within the timeout
or errors, drop to `idle` + `needs_input` (a stalled session nags for attention
rather than masquerading as done). This also resolves the parser/view
inconsistency: the single default everywhere is `needs_input`.

## Agents View, derived

```
WORKING      → live + working   (includes "classifying…")
NEEDS INPUT  → live + idle + needs_input
COMPLETED    → live + idle + completed
```

- `draft` and `archived` never appear.
- Sort: section rank → `modified` desc. The competing 7-way status rank in
  `daemon-list-format.ts:5` goes away (or is rederived from the axes for the CLI
  list).
- Type-to-search filters the visible rows over the full transcript text (port
  the existing `session-selector-search.ts` engine in); the chat/new-session
  field is removed from this view.

## Migration

Staged so each step is independently shippable.

1. **Introduce the axes as types** alongside the old ones; derive new from old in
   one place. New: `SessionLifecycle = "draft" | "live" | "archived"`,
   `SessionActivity = "working" | "idle"`, reuse `AgentTaskState` for axis 3.
2. **Rewrite `classifyAgentsViewSession`** to read (lifecycle, activity,
   taskState) instead of the raw `SessionStatus` union. Fold the
   classification-in-flight → `working` rule in here.
3. **Fix visibility:** `shouldShowAgentsViewSession` keys off lifecycle
   (`live` only) rather than `activeSessionId`. Surface on-disk `live` sessions,
   not just daemon-resident ones.
4. **Rename `sleep` → `archived`** across the saved-state type, persistence
   (`session-manager` append/read), the `ctrl+x` handler
   (`agents-view-mode.ts:1370`), and detach (`daemon-mode.ts:1544`). Keep a
   back-compat read shim for existing on-disk `"sleep"` records.
5. **Remove the deferred path:** delete `DeferredAgentConnection` and the
   `discardEmptyDaemonSession` wiring; `prime-agent` opens a `draft` directly,
   promoted to `live` on first send. Removes the `created`/`ensure`/`promote`/
   `defaultState`/`dispose` branching.
6. **Classification timeout → `idle` + `needs_input`** in the summarizer
   (`daemon-session-summarizer.ts`), and align the view default to `needs_input`.
7. **Collapse live status:** `activeStatusForSession` returns the
   `working`/`idle` activity instead of `user`/`tool`/`model`/`idle`. Attachment
   count stays as its own field.
8. **Port transcript search into the view; remove the chat field.**

### Files touched

- `packages/coding-agent/src/modes/daemon/daemon-session-list.ts` — status type, `SessionSummary`, `activeStatusForSession`, summary builders
- `packages/coding-agent/src/modes/agent-connection/types.ts` — saved-state type rename
- `packages/coding-agent/src/modes/agents-view/agents-view-state.ts` — classify, visibility, sort, status labels
- `packages/coding-agent/src/modes/agents-view/agents-view-mode.ts` — `ctrl+x` archive, search wiring, chat-field removal
- `packages/coding-agent/src/modes/agent-connection/deferred-agent-connection.ts` — **delete**
- `packages/coding-agent/src/main.ts` — draft creation replaces deferred wiring
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts` — resume/detach lifecycle transitions
- `packages/coding-agent/src/core/session-manager.ts` — persisted state, back-compat shim
- `packages/coding-agent/src/modes/daemon/daemon-session-summarizer.ts` — timeout → needs_input
- `packages/coding-agent/src/cli/daemon-list-format.ts` — rederive list order from axes
- `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts` — reused by the view

## Open questions

- Back-compat: how long to keep reading legacy on-disk `"sleep"` before dropping
  the shim?
- Classification timeout value (current sweep is 25s / settle debounce 2s in
  `daemon-session-summarizer.ts`).
- Does the CLI `prime list` keep its own ordering, or fully adopt the view's
  section → modified sort?

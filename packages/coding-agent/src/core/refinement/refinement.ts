import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import type { CustomEntry } from "../session-manager.js";

export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";

export const REFINE_SKILL_NAME = "refine";
const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;
// The detail tier is already bounded by maxEntriesPerKind, so a character budget there could only
// ever render fewer content-bearing entries than the caller asked for. It stays off by default and
// is an opt-in rail for callers that raise maxEntriesPerKind.
const DEFAULT_OVERVIEW_DETAIL_BUDGET = Number.POSITIVE_INFINITY;
const DEFAULT_OVERVIEW_LISTED_LIMIT = 200;
// One budget for the whole stub menu, not per kind. The stub tier is the only part of the overview
// that grows with the store, so this is the number that decides whether the prompt still fits a
// small context window: 8,000 characters is about 2,000 tokens by the repository's chars/4
// estimator, against models this repo ships with a 16,384-token window and smaller.
const DEFAULT_OVERVIEW_LISTED_CHAR_BUDGET = 8000;
// Prompt-size policy behind the context-aware menu cap. Chars-per-token matches the conservative
// chars/4 estimator in compaction.ts, and the share holds half of the window back for the
// conversation and the model's output. Both feed `affordableOverviewListedChars`, which is how the
// 8,000-character default above degrades on models whose window cannot afford it.
const OVERVIEW_CHARS_PER_TOKEN = 4;
const OVERVIEW_PROMPT_WINDOW_SHARE = 0.5;
// Target length for a stub line. The `[scope:id]` address is exempt - see `overviewStubLine`.
const OVERVIEW_STUB_LINE_LIMIT = 160;
// Shortest remainder worth appending after the address: one character plus the "..." marker.
const OVERVIEW_STUB_MIN_REMAINDER = 4;

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

const REFINEMENT_SYSTEM_PROMPT = `You are Prime Agent's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Prime Agent improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, IPython kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm("sub-task")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Prime Agent's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

/**
 * Output budgets are derived from the selected model instead of fixed literals.
 * /refine input scales with harness size (entry overview, refinement history, and
 * the trajectory slice), so a constant output cap silently truncates exactly the
 * large multi-edit proposals that matter most. Math.min keeps small models honest.
 */
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
}

function autoRefineReviewMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
}

function now(): string {
	return new Date().toISOString();
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
	if (result.scope) {
		return result.scope;
	}

	const scopes = new Set<HarnessScope>();
	for (const edit of result.appliedEdits) {
		const scope = edit.after?.scope ?? edit.before?.scope;
		if (scope) {
			scopes.add(scope);
		}
	}
	return scopes.size === 1 ? [...scopes][0] : undefined;
}

function withDefaultRefinementScope(result: RefinementResult, scope: HarnessScope): RefinementResult {
	const inferred = inferRefinementResultScope(result);
	return { ...result, scope: inferred ?? scope };
}

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

export function loadHarnessState(
	harnessStateDir: string = getGlobalHarnessStateDir(),
	scope: HarnessScope = "global",
): HarnessState {
	const statePath = getHarnessStatePath(harnessStateDir);
	if (!existsSync(statePath)) {
		return emptyHarnessState();
	}
	let parsed: Partial<HarnessState>;
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8"));
		// loadHarnessState runs on every system-prompt build and before each /refine, so
		// a corrupt or unreadable (or non-object) state file must degrade to empty rather
		// than throw and break the session. The next saveHarnessState rewrites it cleanly.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyHarnessState();
		}
		parsed = raw as Partial<HarnessState>;
	} catch {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : 1;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = objectRecord(rawEntry);
				if (!entry) continue;
				// Mirror the Python loader in harness.py: these fields are interpolated into
				// prompt lines, so an entry without string title/content is dropped rather than
				// rendering "undefined" or crashing compactText, and id/kind come from the
				// enclosing key so a rendered address always names a real store key.
				if (typeof entry.title !== "string" || typeof entry.content !== "string") continue;
				state.entries[kind][id] = {
					...(entry as unknown as HarnessEntry),
					id,
					kind,
					path: typeof entry.path === "string" ? entry.path : "general",
					source: typeof entry.source === "string" ? entry.source : "agent",
					version: normalizeEntryVersion(entry.version),
					scope: normalizeHarnessScope(entry.scope, scope),
					reference: objectRecord(entry.reference) ?? {},
					arguments: objectRecord(entry.arguments) ?? {},
					metadata: objectRecord(entry.metadata) ?? {},
				};
			}
		}
	}
	state.refinements = normalizeRefinementEvents(parsed.refinements);
	return state;
}

function normalizeEntryVersion(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 1;
}

/**
 * Mirror the Python loader for refinement events: an event renders into the overview, so it must
 * carry a string id and trigger plus a list of string changes. Anything else from disk is dropped
 * rather than crashing the prompt build on `changes.length` or interpolating a non-string.
 */
function normalizeRefinementEvents(value: unknown): HarnessRefinementEvent[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const events: HarnessRefinementEvent[] = [];
	for (const rawEvent of value) {
		const event = objectRecord(rawEvent);
		if (!event || typeof event.id !== "string" || typeof event.trigger !== "string") continue;
		const changes =
			typeof event.changes === "string"
				? [event.changes]
				: Array.isArray(event.changes)
					? event.changes.map(String)
					: undefined;
		if (!changes) continue;
		events.push({
			id: event.id,
			trigger: event.trigger,
			changes,
			evidence: typeof event.evidence === "string" ? event.evidence : "",
			outcome: typeof event.outcome === "string" ? event.outcome : "",
			created_at: typeof event.created_at === "string" ? event.created_at : "",
		});
	}
	return events;
}

export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

export function saveHarnessState(harnessStateDir: string, state: HarnessState): string {
	const statePath = getHarnessStatePath(harnessStateDir);
	const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(harnessStateDir, { recursive: true });
	try {
		const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
		writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tempPath, statePath);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return statePath;
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/**
 * Append a global-scope refinement to the cross-session history log so it can be
 * rolled back from any session. Local-scope refinements are recorded only in the
 * session JSONL and roll back via their recorded harnessStatePath.
 */
export function appendGlobalRefinement(harnessStateDir: string, result: RefinementResult): string {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	appendFileSync(historyPath, `${JSON.stringify(result)}\n`, "utf8");
	return historyPath;
}

export function loadGlobalRefinementHistory(harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(historyPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(withDefaultRefinementScope(parsed, "global"));
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/**
 * Merge global and session refinement history, de-duplicating by id. Session entries
 * win on conflict so a session that is mid-flight still resolves its own latest result.
 */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	session: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
	}
	return [...byId.values()];
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function compactText(text: string, maxLength: number): string {
	const normalized = collapseWhitespace(text);
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

// A rendered overview address is `[scope:id]` at the start of a line, and every read path -
// `_strip_scope_prefix` in the Python harness above all - takes the id back verbatim, up to the
// first "]". No escaping is decoded anywhere. An id carrying "[", "]", or a control character (a
// newline above all) therefore renders as one or more addresses the store cannot resolve, which is
// #819's unaddressable-stub defect reintroduced through data. The rule is shared with the Python
// writer in prime-agent-runtime/src/rlm/harness.py.
/** Whether an id round-trips through a rendered `[scope:id]` overview address. */
export function isAddressableHarnessId(id: string): boolean {
	if (id.length === 0) {
		return false;
	}
	for (const char of id) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || char === "[" || char === "]") {
			return false;
		}
	}
	return true;
}

/**
 * The stub-menu budget `formatHarnessStateForPrompt` will actually use for a raw `maxListedChars`,
 * applying the same fallback rules as the renderer: invalid values mean the 8,000-character
 * default, and 0 means the menu is off.
 */
export function resolvedOverviewListedChars(maxListedChars: number | undefined): number {
	return resolveOverviewLimit(maxListedChars, DEFAULT_OVERVIEW_LISTED_CHAR_BUDGET, 0);
}

/**
 * The largest stub-menu budget a model's context window affords once the rest of the system prompt
 * is spent. The window is in tokens; the estimate is the repository's conservative chars/4, and
 * half of the window is held back for the conversation and the model's output, so the menu can
 * never be the reason a supported small-context model overflows on its first request. Returns 0
 * when the menu-free prompt alone reaches the allowance.
 */
export function affordableOverviewListedChars(contextWindow: number, promptCharsWithoutMenu: number): number {
	const targetPromptChars = Math.floor(contextWindow * OVERVIEW_CHARS_PER_TOKEN * OVERVIEW_PROMPT_WINDOW_SHARE);
	return Math.max(0, targetPromptChars - Math.max(0, promptCharsWithoutMenu));
}

/**
 * Numeric limits for the continual harness overview rendered into the system prompt.
 *
 * Every value is normalized by the renderer: anything that is not a number, is not finite, or is
 * below the field's minimum falls back to the default documented on that field, so an invalid limit
 * cannot reach the prompt as a `NaN` slice bound or silently disable a tier.
 */
export interface HarnessOverviewLimits {
	/** Entries per kind rendered with their content. Minimum 1. Default: 6. */
	maxEntriesPerKind?: number;
	/** Characters kept per rendered content, `ref=`, and `args=` value. Minimum 1. Default: 180. */
	maxContentLength?: number;
	/**
	 * Characters spent on content-bearing entries per kind. Minimum 1. Unset means no character rail:
	 * `maxEntriesPerKind` alone decides how many entries keep their content.
	 */
	detailBudget?: number;
	/** One-line stubs per kind after the content-bearing entries. Minimum 0. Default: 200. */
	maxListedEntries?: number;
	/**
	 * Characters spent on the stub menu across all kinds, split evenly between the kinds that need
	 * stubs. Minimum 0, where 0 disables the menu. Default: 8000.
	 */
	maxListedChars?: number;
}

/**
 * Resolve a caller-supplied numeric limit. `formatHarnessStateForPrompt` and `selectOverviewEntries`
 * are exported, so a limit arriving as `NaN` must not flow into a slice bound or an overflow count,
 * where it would silently drop entries and suppress the `+N more` line that reports them.
 *
 * Out-of-range values fall back rather than clamping to the minimum: `maxListedEntries: -1` is a
 * typo, and clamping it to 0 would turn the stub menu off with no diagnostic. An operator who wants
 * it off writes 0, which is in range.
 */
function resolveOverviewLimit(value: number | undefined, fallback: number, minimum = 1): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const floored = Math.floor(value);
	return floored >= minimum ? floored : fallback;
}

function overviewHeadline(entry: HarnessEntry): string {
	// Title and path are data from disk; collapsing whitespace keeps a multi-line title from
	// fabricating overview rows the store does not contain.
	return `- [${entry.scope ?? "global"}:${entry.id}] ${collapseWhitespace(`${entry.title} (${entry.path}, v${entry.version})`)}`;
}

/**
 * A stub the model can act on. The `[scope:id]` address is never truncated, because a clipped id
 * addresses nothing and an unaddressable stub advertises knowledge that cannot be retrieved - the
 * defect #819 is about. Only the title/path remainder absorbs the clip, so a long address costs
 * more of the menu budget and therefore names fewer entries, which is the correct trade.
 *
 * `overviewDetailLine` leaves the headline alone entirely, so a store that fits in the detail tier
 * renders the same lines it did before this ranking landed.
 */
function overviewStubLine(entry: HarnessEntry): string {
	const address = `- [${entry.scope ?? "global"}:${entry.id}]`;
	const room = OVERVIEW_STUB_LINE_LIMIT - address.length - 1;
	if (room < OVERVIEW_STUB_MIN_REMAINDER) {
		return address;
	}
	return `${address} ${compactText(`${entry.title} (${entry.path}, v${entry.version})`, room)}`;
}

function overviewDetailLine(entry: HarnessEntry, maxContentLength: number): string {
	const argumentsText =
		entry.kind === "skill" && Object.keys(entry.arguments).length > 0
			? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
			: "";
	const referenceText =
		entry.kind === "skill" && Object.keys(entry.reference).length > 0
			? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
			: "";
	return `${overviewHeadline(entry)}${referenceText}${argumentsText}: ${compactText(entry.content, maxContentLength)}`;
}

// An ISO date-time carrying neither an offset nor a trailing "Z". `Date.parse` reads this form in
// the host timezone, so the same state file would rank differently on two machines.
const OFFSETLESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// `loadHarnessState` copies timestamps from disk without validating them, and the TypeScript and
// Python writers emit different ISO forms ("...Z" vs "...+00:00"), so rank on the parsed epoch
// rather than the raw string. An offsetless timestamp is read as UTC rather than as local time,
// because ranking must not depend on the machine. Missing or unparseable timestamps rank last.
function overviewRecency(entry: HarnessEntry): number {
	const raw = entry.updated_at;
	const normalized = typeof raw === "string" && OFFSETLESS_TIMESTAMP.test(raw) ? `${raw}Z` : raw;
	const parsed = Date.parse(normalized);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function overviewTiebreakKey(entry: HarnessEntry): string {
	return [entry.path, entry.title, entry.id, entry.scope ?? "global"].join("\0");
}

function compareOverviewEntries(a: HarnessEntry, b: HarnessEntry): number {
	const aRecency = overviewRecency(a);
	const bRecency = overviewRecency(b);
	if (aRecency !== bRecency) {
		return bRecency > aRecency ? 1 : -1;
	}
	const aVersion = Number.isFinite(a.version) ? a.version : 0;
	const bVersion = Number.isFinite(b.version) ? b.version : 0;
	if (aVersion !== bVersion) {
		return bVersion - aVersion;
	}
	// Compare code points rather than `localeCompare`: the overview is an internal ordering that must
	// not shift with the machine's ICU locale, because prompt caching keys on the rendered bytes.
	// `scope` completes the order - `mergeHarnessStates` can produce local/global pairs that agree on
	// path, title, and id, and without it those pairs compare equal and rank by input order.
	const aKey = overviewTiebreakKey(a);
	const bKey = overviewTiebreakKey(b);
	if (aKey === bKey) {
		return 0;
	}
	return aKey < bKey ? -1 : 1;
}

/**
 * Rank harness entries for the system-prompt overview and split them into content-bearing entries
 * and one-line stubs.
 *
 * Ranking is `updated_at` descending, then `version` descending, then a code-point comparison of
 * `[path, title, id, scope]` so entries written in the same millisecond have a total order. The
 * function is pure and depends on nothing but its arguments - no clock, no filesystem, no
 * randomness, and no ambient locale - so two renders of the same `harness_state.json` are
 * byte-identical on any machine.
 *
 * `opts.query` is accepted and deliberately unused. It is the seam for a future relevance- or
 * utility-ranked selection policy, so that policy can land without changing this signature or its
 * call sites.
 */
export function selectOverviewEntries(
	entries: readonly HarnessEntry[],
	opts: {
		detailBudget?: number;
		maxContentLength?: number;
		reservedRecentSlots?: number;
		query?: string;
	} = {},
): { detailed: HarnessEntry[]; listed: HarnessEntry[] } {
	const detailBudget = resolveOverviewLimit(opts.detailBudget, DEFAULT_OVERVIEW_DETAIL_BUDGET);
	const maxContentLength = resolveOverviewLimit(opts.maxContentLength, DEFAULT_OVERVIEW_CONTENT_LIMIT);
	const reservedRecentSlots = resolveOverviewLimit(opts.reservedRecentSlots, DEFAULT_OVERVIEW_ENTRY_LIMIT, 0);
	const detailed: HarnessEntry[] = [];
	const listed: HarnessEntry[] = [];
	let spent = 0;
	let budgetExhausted = false;
	for (const entry of [...entries].sort(compareOverviewEntries)) {
		if (!budgetExhausted && detailed.length < reservedRecentSlots) {
			const line = overviewDetailLine(entry, maxContentLength);
			// The top-ranked entry always keeps its content, so a tight budget can never hide the
			// lesson a refinement just wrote.
			if (detailed.length === 0 || spent + line.length <= detailBudget) {
				detailed.push(entry);
				spent += line.length;
				continue;
			}
			budgetExhausted = true;
		}
		listed.push(entry);
	}
	return { detailed, listed };
}

export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: HarnessOverviewLimits & {
		maxRefinements?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
	} = {},
): string {
	const maxEntriesPerKind = resolveOverviewLimit(options.maxEntriesPerKind, DEFAULT_OVERVIEW_ENTRY_LIMIT);
	const maxRefinements = resolveOverviewLimit(options.maxRefinements, DEFAULT_OVERVIEW_REFINEMENT_LIMIT, 0);
	const maxContentLength = resolveOverviewLimit(options.maxContentLength, DEFAULT_OVERVIEW_CONTENT_LIMIT);
	const detailBudget = resolveOverviewLimit(options.detailBudget, DEFAULT_OVERVIEW_DETAIL_BUDGET);
	// 0 is meaningful on both stub limits: either one at 0 turns the menu off and restores the
	// count-only overview.
	const maxListedEntries = resolveOverviewLimit(options.maxListedEntries, DEFAULT_OVERVIEW_LISTED_LIMIT, 0);
	const maxListedChars = resolveOverviewLimit(options.maxListedChars, DEFAULT_OVERVIEW_LISTED_CHAR_BUDGET, 0);
	const includeIpythonExamples = options.includeIpythonExamples ?? true;
	const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
	const lines = [
		"# Continual Harness State",
		"",
		"Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
		"The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
		"Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
		"",
		includeRefineExamples
			? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
			: "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
		"",
		includeIpythonExamples
			? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in IPython; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm('sub-task')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
			: options.includeShellExamples
				? "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without IPython; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents an IPython kernel."
				: "Call contract: continual harness entries are routing/context hints only in sessions without IPython or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
		"",
	];

	const selections = (Object.keys(state.entries) as RefinementKind[]).map((kind) => {
		const kindEntries = Object.values(state.entries[kind]);
		// An id that cannot render as an exact `[scope:id]` address is never interpolated into the
		// prompt: a "]" or newline inside it would advertise addresses the store cannot resolve.
		// Such legacy entries stay in the `+N more` count and remain reachable through
		// `rlm.harness.list()` and `delete()`, which is also the cleanup path for them.
		const addressable = kindEntries.filter((entry) => isAddressableHarnessId(entry.id));
		return {
			kind,
			count: kindEntries.length,
			unaddressable: kindEntries.length - addressable.length,
			...selectOverviewEntries(addressable, {
				detailBudget,
				maxContentLength,
				reservedRecentSlots: maxEntriesPerKind,
			}),
		};
	});
	const totalEntries = selections.reduce((running, selection) => running + selection.count, 0);
	// The stub menu gets one budget for the whole overview rather than a per-kind ceiling, so the
	// worst case is a single number an operator can weigh against a context window. Splitting it
	// between the kinds that actually need stubs keeps one large kind from starving the others, and
	// leaves the budget undivided in the common case where only `memory` overflows.
	const stubbedKinds = selections.filter((selection) => selection.listed.length > 0).length;
	const stubBudget = stubbedKinds > 0 ? Math.floor(maxListedChars / stubbedKinds) : 0;

	for (const { kind, count, unaddressable, detailed, listed } of selections) {
		// Render subagent specs as a task-shaped roster the model can match against — the
		// analogue of Claude Code's agent-type menu — rather than a bare count. In
		// IPython sessions, include the native `rlm` invocation hint.
		if (kind === "subagent" && count > 0 && includeIpythonExamples) {
			lines.push(
				`${kind}: ${count} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${count}`);
		}
		for (const entry of detailed) {
			lines.push(overviewDetailLine(entry, maxContentLength));
		}
		// Everything past maxEntriesPerKind still gets an addressable one-line stub, so the model can
		// reach it with `rlm.harness.get(kind, "<scope>:<id>")` instead of only being told a count.
		// Entries the budget cannot afford are skipped rather than ending the menu, so one entry with a
		// very long id costs itself and not everything ranked below it, and they land in the count.
		let spentOnStubs = 0;
		let stubCount = 0;
		for (const entry of listed) {
			if (stubCount >= maxListedEntries || spentOnStubs >= stubBudget) {
				break;
			}
			const line = overviewStubLine(entry);
			if (spentOnStubs + line.length + 1 > stubBudget) {
				continue;
			}
			lines.push(line);
			spentOnStubs += line.length + 1;
			stubCount++;
		}
		const overflow = listed.length - stubCount + unaddressable;
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	// Event ids and change strings are data from disk. An unaddressable id would render a `[...]`
	// tag that resolves to nothing, and a newline inside a change string would fabricate rows, so
	// unrenderable events stay in the overflow count and the change list is collapsed to one line.
	const renderableEvents = state.refinements.filter((event) => isAddressableHarnessId(event.id));
	for (const event of renderableEvents.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? collapseWhitespace(event.changes.join(", ")) : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(renderableEvents.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

function overviewForPrompt(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			// The /refine planning prompt must still surface entries whose ids cannot render as
			// plain addresses - proposing their deletion is the cleanup path - so those ids appear
			// JSON-escaped. The refiner echoes the escaped literal back inside its JSON edit, and
			// the parser decodes it to the exact stored id.
			const address = isAddressableHarnessId(entry.id) ? entry.id : JSON.stringify(entry.id);
			lines.push(
				`- [${entry.scope ?? "global"}:${address}] ${collapseWhitespace(`${entry.title} (${entry.path}, v${entry.version})`)}${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > 40) {
			lines.push(`- +${entries.length - 40} more ${kind} entries`);
		}
	}
	return lines.join("\n");
}

function historyForPrompt(history: RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits
				.map((edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		// A reply truncated after a nested closing brace still looks well-formed
		// here, so this path needs the same diagnosis as the slicing fallback.
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside the
	// edits array it slices to an earlier edit's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Refiner JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const edits = Array.isArray(record.edits) ? record.edits : [];
	return {
		summary: typeof record.summary === "string" ? record.summary : "Refined continual harness state",
		rationale: typeof record.rationale === "string" ? record.rationale : "",
		expectedOutcome: typeof record.expectedOutcome === "string" ? record.expectedOutcome : "",
		edits: edits
			.filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
			.map((edit) => ({
				action: edit.action as RefinementAction,
				kind: edit.kind as RefinementKind,
				id: typeof edit.id === "string" ? edit.id : undefined,
				title: typeof edit.title === "string" ? edit.title : undefined,
				content: typeof edit.content === "string" ? edit.content : undefined,
				path: typeof edit.path === "string" ? edit.path : undefined,
				reference: objectRecord(edit.reference),
				arguments: objectRecord(edit.arguments),
				metadata:
					typeof edit.metadata === "object" && edit.metadata !== null && !Array.isArray(edit.metadata)
						? (edit.metadata as Record<string, unknown>)
						: undefined,
				reason: typeof edit.reason === "string" ? edit.reason : undefined,
			})),
	};
}

function validateEdit(edit: RefinementEdit, computedId?: string): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	// Delete stays exempt so an unaddressable id that reached a legacy state file can still be
	// removed; create and update must not persist content under an id the overview cannot render.
	if (edit.action !== "delete" && !isAddressableHarnessId(computedId ?? edit.id ?? "")) {
		return `${edit.action} id must not contain "[", "]", or control characters`;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
		return `${edit.action} skill requires arguments`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const reference = edit.reference;
		if (!reference) {
			return `${edit.action} skill requires python reference`;
		}
		if (reference.type !== "python") {
			return `${edit.action} skill reference.type must be python`;
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.length > 0);
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.length > 0);
		if (!hasImport) {
			return `${edit.action} skill requires python import`;
		}
		if (!hasCallable) {
			return `${edit.action} skill requires callable or call_pattern`;
		}
	}
	return undefined;
}

export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	for (const edit of proposal.edits) {
		// `||` rather than `??`: an explicit empty id on create falls back to the title slug, the
		// same way the Python writer's `id or _slug(...)` does, instead of minting an entry whose
		// rendered address `[scope:]` resolves to nothing.
		const computedId = edit.id || (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		const id = computedId ?? "";
		const validationError = validateEdit(edit, id);
		if (validationError) {
			appliedEdits.push({ ...edit, id, applied: false, error: validationError });
			continue;
		}

		const records = state.entries[edit.kind];
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(before) !== JSON.stringify(baseline)
		) {
			appliedEdits.push({
				...edit,
				id,
				before,
				applied: false,
				error: "entry changed during refinement planning",
			});
			continue;
		}
		if (edit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			delete records[id];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}
		if (edit.action === "create" && before) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (edit.action === "update" && !before) {
			appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
			continue;
		}

		const createdAt = before?.created_at ?? now();
		const version = before ? before.version + 1 : 1;
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: createdAt,
			updated_at: now(),
			version,
		};
		records[id] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...edit, id, before, after: cloneEntry(after), applied: true });
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		rollbackOf: options.rollbackOf,
		scope: options.scope,
	};
}

function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({
				action: "delete",
				kind: edit.kind,
				id: edit.id,
				reason: `Rollback ${target.id}`,
			});
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

export function getRefinementHistory(entries: readonly CustomEntry[]): RefinementResult[] {
	return entries
		.filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((data): data is RefinementResult => {
			return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
		});
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	/** Target-scope state captured before planning, used to reject conflicting edits at apply time. */
	baselineState?: HarnessState;
}

/**
 * Produce a refinement proposal (the LLM pass, or a rollback proposal) without
 * mutating any harness state. Separated from {@link applyRefinementProposal} so
 * callers can re-read the harness file immediately before applying — the LLM call
 * here can take many seconds, during which the kernel or another session may write
 * the shared `harness_state.json`.
 */
export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	const id = `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	const userPrompt = [
		`<current_harness_state>\n${overviewForPrompt(state)}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<conversation>\n${conversationText}\n</conversation>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	// /refine requires a parseable JSON object in the final text. Some reasoning-capable
	// OpenAI-compatible models can spend the response on visible thinking and return no
	// final text, which makes otherwise successful daemon /refine calls fail parsing.
	// Keep the refinement request non-reasoning regardless of the interactive session
	// thinking level so the model uses its output budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: REFINEMENT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: refinementMaxOutputTokens(model), signal, apiKey, headers },
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const userPrompt = [
		`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
		`<current_harness_state>
${overviewForPrompt(state)}
</current_harness_state>`,
		`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
		`<conversation>
${conversationText}
</conversation>`,
		"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
	].join("\n\n");
	// Auto-refine review requires parseable JSON. Keep it non-reasoning so
	// reasoning-capable models use final text budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: autoRefineReviewMaxOutputTokens(model), signal, apiKey, headers },
	);
	if (response.stopReason === "error") {
		throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	const plan = await planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
	});
}

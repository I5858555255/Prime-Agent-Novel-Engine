/**
 * Context-routing policy example.
 *
 * This is a routing aid, not a security boundary. It nudges the model toward
 * jCodeMunch for whole source files and Context Mode for web/docs/logs/large
 * data, while keeping edits, tests, builds, and git work in Prime Agent.
 *
 * Usage:
 *   pi -e ./context-routing.ts --context-routing advisory
 *   pi -e ./context-routing.ts --context-routing strict-large-read
 *   pi -e ./context-routing.ts --context-routing advisory --context-routing-fast-reindex=off
 *
 * Runtime controls:
 *   /context-routing off|advisory|strict-large-read
 *   /context-routing stats
 *
 * Successful IPython edit results also enqueue bounded, best-effort jCodeMunch
 * reindexes for changed regular source files. The path is advisory because the
 * watcher remains authoritative; use `--context-routing-fast-reindex=off` to
 * disable this direct CLI fast path.
 *
 * Strict mode has intentionally narrow recognition. To explicitly bypass a
 * routing block, put `# context-routing: bypass` as the first non-blank line
 * of the IPython cell. `# context-routing: fallback` is for a documented
 * unavailable-integration fallback.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IpythonToolResultEvent } from "../../src/core/extensions/types.js";

export const CONTEXT_ROUTING_FLAG = "context-routing";
export const CONTEXT_ROUTING_FAST_REINDEX_FLAG = "context-routing-fast-reindex";
export const CONTEXT_ROUTING_MODES = ["off", "advisory", "strict-large-read"] as const;
export type ContextRoutingMode = (typeof CONTEXT_ROUTING_MODES)[number];

/** Whole-file reads at or below this size are treated as small when stat-able. */
export const SMALL_FILE_BYTES = 16 * 1024;

export type ContextRoutingPattern = "curl/wget stdout" | "cat whole-file dump" | "python whole-file print";

export interface ContextRoutingInspection {
	decision: "allow" | "block";
	pattern?: ContextRoutingPattern;
	reason: string;
}

export interface ContextRoutingTelemetryEvent {
	kind: "turn-guidance" | "inspection";
	mode: ContextRoutingMode;
	action: "advisory" | "allow" | "block";
	pattern?: ContextRoutingPattern;
}

export type ContextRoutingTelemetryHook = (event: ContextRoutingTelemetryEvent) => void;

export interface ContextRoutingStats {
	turnsGuided: number;
	cellsInspected: number;
	allowed: number;
	blocked: number;
}

export interface ContextRoutingFastReindexQueueOptions {
	command?: string;
	concurrency?: number;
	reindexFile?: (absolutePath: string, cwd: string) => Promise<void> | void;
	spawnProcess?: typeof spawn;
}

export interface ContextRoutingInstallOptions {
	telemetry?: ContextRoutingTelemetryHook;
	/** Disable the advisory fast path while leaving the watcher authoritative. */
	fastReindex?: boolean;
	fastReindexCommand?: string;
	fastReindexConcurrency?: number;
	/** Test hook; production uses the separately installed jCodeMunch CLI. */
	reindexFile?: (absolutePath: string, cwd: string) => Promise<void> | void;
}

const JCODEMUNCH_COMMAND = "jcodemunch-mcp";
const FAST_REINDEX_CONCURRENCY = 2;
const GENERATED_PATH_PATTERN =
	/(?:^|\/)(?:\.git|node_modules|dist|build|coverage|out|target|generated|gen|__pycache__|\.next)(?:\/|$)|(?:^|\/)[^/]*\.(?:generated|gen)\.[^/]+$/i;

function safeChildEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"HOME",
		"USERPROFILE",
		"SystemRoot",
		"TMPDIR",
		"TMP",
		"TEMP",
		"JCODEMUNCH_HOME",
		"JCODEMUNCH_CONFIG",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Return an absolute, existing regular file that is safe for the advisory path. */
export function resolveFastReindexPath(changedPath: unknown, cwd: string): string | undefined {
	if (typeof changedPath !== "string" || changedPath.trim().length === 0) return undefined;
	const absolutePath = path.resolve(cwd, changedPath);
	if (GENERATED_PATH_PATTERN.test(absolutePath.replaceAll("\\", "/"))) return undefined;
	try {
		return statSync(absolutePath).isFile() ? absolutePath : undefined;
	} catch {
		return undefined;
	}
}

function normalizeConcurrency(value: number | undefined): number {
	if (!Number.isFinite(value)) return FAST_REINDEX_CONCURRENCY;
	return Math.min(FAST_REINDEX_CONCURRENCY, Math.max(1, Math.floor(value ?? FAST_REINDEX_CONCURRENCY)));
}

function normalizeFastReindexFlag(value: boolean | string | undefined): boolean {
	if (typeof value === "boolean") return value;
	return !["off", "false", "0", "disabled", "no"].includes(value?.trim().toLowerCase() ?? "");
}

function reindexWithJCodeMunch(
	command: string,
	absolutePath: string,
	cwd: string,
	spawnProcess: typeof spawn,
): Promise<void> {
	return new Promise((resolve) => {
		try {
			const child = spawnProcess(command, ["index-file", "--no-ai-summaries", absolutePath], {
				cwd,
				shell: false,
				stdio: "ignore",
				windowsHide: true,
				env: safeChildEnvironment(),
			});
			child.once("error", () => resolve());
			child.once("close", () => resolve());
		} catch {
			resolve();
		}
	});
}

/**
 * Queue best-effort file reindexes without making tool-result delivery wait.
 * The watcher remains the source of truth if this process or sidecar is absent.
 */
export function createFastReindexQueue(options: ContextRoutingFastReindexQueueOptions = {}) {
	const pending = new Map<string, string>();
	const active = new Set<string>();
	const waiters: Array<() => void> = [];
	const concurrency = normalizeConcurrency(options.concurrency);
	const reindexFile =
		options.reindexFile ??
		((absolutePath: string, cwd: string) =>
			reindexWithJCodeMunch(
				options.command ?? JCODEMUNCH_COMMAND,
				absolutePath,
				cwd,
				options.spawnProcess ?? spawn,
			));
	let running = 0;

	const resolveIdle = () => {
		if (running !== 0 || pending.size !== 0) return;
		for (const resolve of waiters.splice(0)) resolve();
	};

	const drain = () => {
		while (running < concurrency && pending.size > 0) {
			const entry = pending.entries().next().value as [string, string] | undefined;
			if (!entry) break;
			const [absolutePath, cwd] = entry;
			pending.delete(absolutePath);
			active.add(absolutePath);
			running += 1;
			void (async () => {
				try {
					if (resolveFastReindexPath(absolutePath, cwd)) await reindexFile(absolutePath, cwd);
				} catch {
					// Reindexing is advisory; the watcher will retry or catch up later.
				} finally {
					active.delete(absolutePath);
					running -= 1;
					drain();
					resolveIdle();
				}
			})();
		}
		resolveIdle();
	};

	return {
		enqueue(paths: readonly string[], cwd: string): void {
			for (const absolutePath of paths) {
				if (!active.has(absolutePath) && !pending.has(absolutePath)) pending.set(absolutePath, cwd);
			}
			drain();
		},
		whenIdle(): Promise<void> {
			if (running === 0 && pending.size === 0) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
}

interface ParsedBashCell {
	body: string;
}

interface ShellSegment {
	text: string;
	stdoutRedirected: boolean;
}

const BASH_CELL_PATTERN = /^(?:[ \t]*\r?\n)*[ \t]*%%bash\b[^\r\n]*(?:\r?\n|$)/;
const BYPASS_MARKER_PATTERN = /^#\s*context-routing\s*:\s*(?:allow|bypass)\s*$/i;
const FALLBACK_MARKER_PATTERN = /^#\s*context-routing\s*:\s*fallback\s*$/i;
const IMPORT_FALLBACK_PATTERN =
	/\btry\b[\s\S]{0,1000}\bexcept\s+(?:ImportError|ModuleNotFoundError)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*:/i;
const SHELL_FALLBACK_PATTERN = /\b(?:command\s+-v|which)\s+[^\r\n;|&]+(?:\s[^\r\n;|&]+)?\s*\|\|/i;
const INTEGRATION_FALLBACK_PATTERN =
	/\b(?:jcodemunch|context[-_ ]?mode|mcp)\b[\s\S]{0,120}\b(?:unavailable|not available|missing|fallback)\b/i;
const SHELL_KEYWORD_PATTERN = /^(?:(?:if|then|else|elif|do|while|until|for|case|!|command)\s+)+/i;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]*|"[^"]*"|'[^']*')\s+/;
const CURL_OUTPUT_PATTERN = /(?:^|\s)(?:-o|--output|--output-document)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/i;
const CURL_STDOUT_OUTPUT_PATTERN = /(?:^|\s)(?:-o|--output|--output-document)(?:=|\s+)(?:-|"-"|'-')(?=\s|$)/i;
const CURL_FILE_OUTPUT_PATTERN = /(?:^|\s)(?:-O|--remote-name)(?=\s|$)/i;
const WGET_STDOUT_PATTERN =
	/(?:^|\s)(?:-O(?:\s+|-)?-|--output-document(?:=|\s+)(?:-|"-"|'-')|-[A-Za-z]*q[A-Za-z]*O-)(?=\s|$)/i;
const WGET_OUTPUT_PATTERN = /(?:^|\s)(?:-O|--output-document)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/i;
const HEAD_REQUEST_PATTERN = /(?:^|\s)(?:-I|--head)(?=\s|$)/i;
const BOUNDED_PIPELINE_PATTERN = /\|\s*(?:head|tail)(?:\s|$)/i;

function normalizeMode(value: boolean | string | undefined): ContextRoutingMode {
	return typeof value === "string" && (CONTEXT_ROUTING_MODES as readonly string[]).includes(value)
		? (value as ContextRoutingMode)
		: "off";
}

function firstNonBlankLine(code: string): string | undefined {
	return code
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function hasLeadingMarker(code: string, pattern: RegExp): boolean {
	const firstLine = firstNonBlankLine(parseBashCell(code)?.body ?? code);
	return firstLine !== undefined && pattern.test(firstLine);
}

function hasFallbackGuard(code: string): boolean {
	const bashCell = parseBashCell(code);
	const fallbackText = bashCell
		? bashCell.body.replace(/(^|\r?\n)[ \t]*#.*(?=\r?$)/gm, "$1")
		: maskPythonStrings(code);
	return (
		hasLeadingMarker(code, FALLBACK_MARKER_PATTERN) ||
		IMPORT_FALLBACK_PATTERN.test(fallbackText) ||
		SHELL_FALLBACK_PATTERN.test(fallbackText) ||
		INTEGRATION_FALLBACK_PATTERN.test(fallbackText)
	);
}

function parseBashCell(code: string): ParsedBashCell | undefined {
	const match = BASH_CELL_PATTERN.exec(code);
	if (!match) return undefined;
	return { body: code.slice(match[0].length) };
}

function splitShellSegments(body: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let start = 0;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let stdoutRedirected = false;

	const push = (end: number) => {
		const text = body.slice(start, end).trim();
		if (text.length > 0) segments.push({ text, stdoutRedirected });
		start = end;
		stdoutRedirected = false;
	};

	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			continue;
		}
		if (character === "'") {
			quote = "single";
			continue;
		}
		if (character === '"') {
			quote = "double";
			continue;
		}
		if (character === "#" && (index === 0 || /\s/.test(body[index - 1] ?? ""))) {
			const newline = body.indexOf("\n", index);
			if (newline === -1) break;
			index = newline - 1;
			continue;
		}
		if (character === ">") {
			const previous = body[index - 1];
			if (previous !== "2") stdoutRedirected = true;
			continue;
		}
		if (character === "\n" || character === ";") {
			push(index);
			start = index + 1;
			continue;
		}
		if ((character === "&" || character === "|") && body[index + 1] === character) {
			push(index);
			index += 1;
			start = index + 1;
		}
	}
	push(body.length);
	return segments;
}

function shellWords(text: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;

	const push = () => {
		if (current.length > 0) words.push(current);
		current = "";
	};

	for (const character of text.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else current += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (/\s/.test(character)) push();
		else current += character;
	}
	push();
	return words;
}

function resolveSmallFile(fileName: string | undefined, cwd: string | undefined): boolean {
	if (!fileName || !cwd || fileName === "-" || /[$*?{}<>|&;]/.test(fileName)) return false;
	const unquoted = fileName.replace(/^['"]|['"]$/g, "");
	if (unquoted.startsWith("~")) return false;
	try {
		const stats = statSync(path.isAbsolute(unquoted) ? unquoted : path.resolve(cwd, unquoted));
		return stats.isFile() && stats.size <= SMALL_FILE_BYTES;
	} catch {
		return false;
	}
}

function allCatInputsAreSmall(words: string[], cwd: string | undefined): boolean {
	const inputs = words.slice(1).filter((word) => !word.startsWith("-"));
	return inputs.length > 0 && !inputs.includes("-") && inputs.every((fileName) => resolveSmallFile(fileName, cwd));
}

function commandAfterShellPreamble(text: string): string {
	let result = text.trim().replace(SHELL_KEYWORD_PATTERN, "");
	while (ENV_ASSIGNMENT_PATTERN.test(result)) result = result.replace(ENV_ASSIGNMENT_PATTERN, "");
	return result.trim();
}

function inspectBashCell(cell: ParsedBashCell, cwd: string | undefined): ContextRoutingInspection {
	for (const segment of splitShellSegments(cell.body)) {
		const command = commandAfterShellPreamble(segment.text);
		const words = shellWords(command);
		const executable = words[0]?.toLowerCase();
		if (!executable || segment.stdoutRedirected || BOUNDED_PIPELINE_PATTERN.test(command)) continue;

		if ((executable === "curl" || executable === "curl.exe") && !HEAD_REQUEST_PATTERN.test(command)) {
			if (
				(!CURL_OUTPUT_PATTERN.test(command) && !CURL_FILE_OUTPUT_PATTERN.test(command)) ||
				CURL_STDOUT_OUTPUT_PATTERN.test(command)
			) {
				return {
					decision: "block",
					pattern: "curl/wget stdout",
					reason: "Raw curl output would expand context; redirect it to a file or use a bounded parser.",
				};
			}
		}

		if (executable === "wget" || executable === "wget.exe") {
			if (
				WGET_STDOUT_PATTERN.test(command) ||
				(!WGET_OUTPUT_PATTERN.test(command) && /(?:^|\s)-qO-?(?:\s|$)/i.test(command))
			) {
				return {
					decision: "block",
					pattern: "curl/wget stdout",
					reason: "Raw wget output would expand context; redirect it to a file or use a bounded parser.",
				};
			}
		}

		if (executable === "cat" || executable === "cat.exe") {
			if (!allCatInputsAreSmall(words, cwd)) {
				return {
					decision: "block",
					pattern: "cat whole-file dump",
					reason: "A broad cat dump would expand context; use a bounded slice or redirect it to a file.",
				};
			}
		}
	}
	return { decision: "allow", reason: "No high-confidence broad-read pattern recognized." };
}

interface CallExpression {
	name: string;
	argumentsText: string;
	end: number;
}

function skipPythonString(source: string, start: number): number {
	const quote = source[start] as "'" | '"' | undefined;
	if (quote !== "'" && quote !== '"') return start + 1;
	const triple = source.startsWith(quote.repeat(3), start);
	const delimiter = triple ? quote.repeat(3) : quote;
	let escaped = false;
	for (let index = start + delimiter.length; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (source.startsWith(delimiter, index)) return index + delimiter.length;
	}
	return source.length;
}

function findCalls(source: string, names: readonly string[]): CallExpression[] {
	const calls: CallExpression[] = [];
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] === "#") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline;
			continue;
		}
		if (source[index] === "'" || source[index] === '"') {
			index = skipPythonString(source, index) - 1;
			continue;
		}
		const match = /[A-Za-z_][A-Za-z0-9_.]*/y;
		match.lastIndex = index;
		const identifier = match.exec(source)?.[0];
		if (!identifier || !names.includes(identifier)) continue;
		let open = index + identifier.length;
		while (/\s/.test(source[open] ?? "")) open += 1;
		if (source[open] !== "(") continue;

		let depth = 1;
		let quote: string | undefined;
		let escaped = false;
		let end = open + 1;
		for (; end < source.length && depth > 0; end += 1) {
			const character = source[end];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (quote) {
				if (character === quote) quote = undefined;
				continue;
			}
			if (character === "'" || character === '"') {
				end = skipPythonString(source, end) - 1;
			} else if (character === "#") {
				const newline = source.indexOf("\n", end);
				end = newline === -1 ? source.length : newline;
			} else if (character === "(") {
				depth += 1;
			} else if (character === ")") {
				depth -= 1;
			}
		}
		if (depth === 0) {
			calls.push({ name: identifier, argumentsText: source.slice(open + 1, end - 1), end });
			index = end - 1;
		}
	}
	return calls;
}

function extractLiteralPath(expression: string): string | undefined {
	const match = /\b(?:Path|open)\s*\(\s*(["'])([^"']+)\1/.exec(expression);
	return match?.[2];
}

function maskPythonStrings(expression: string): string {
	let masked = "";
	let quote: "'" | '"' | undefined;
	let triple = false;
	let escaped = false;
	let comment = false;
	for (let index = 0; index < expression.length; index += 1) {
		const character = expression[index];
		if (comment) {
			if (character === "\n" || character === "\r") comment = false;
			masked += character === "\n" || character === "\r" ? character : " ";
			continue;
		}
		if (quote) {
			if (triple && expression.startsWith(quote.repeat(3), index)) {
				masked += "   ";
				index += 2;
				quote = undefined;
				triple = false;
			} else {
				if (escaped) escaped = false;
				else if (character === "\\" && quote === '"') escaped = true;
				else if (!triple && character === quote) quote = undefined;
				masked += character === "\n" || character === "\r" ? character : " ";
			}
			continue;
		}
		if (character === "#") {
			comment = true;
			masked += " ";
		} else if (expression.startsWith("'''", index) || expression.startsWith('"""', index)) {
			quote = character === "'" ? "'" : '"';
			triple = true;
			masked += "   ";
			index += 2;
		} else if (character === "'" || character === '"') {
			quote = character;
			triple = false;
			masked += " ";
		} else {
			masked += character;
		}
	}
	return masked;
}

function readIsBounded(expression: string): boolean {
	return (
		/\.(?:read_text|read)\s*\([^)]*\)\s*\[\s*(?:\d*\s*:\s*)?\d+\s*\]/.test(expression) ||
		/\.read\s*\(\s*\d+\s*\)/.test(expression)
	);
}

function isWholeFilePrint(expression: string, cwd: string | undefined): boolean {
	const maskedExpression = maskPythonStrings(expression);
	if (!/\b(?:read_text|read)\s*\(/.test(maskedExpression)) return false;
	if (readIsBounded(maskedExpression)) return false;
	const fileName = extractLiteralPath(expression);
	return !resolveSmallFile(fileName, cwd);
}

function inspectPythonCode(code: string, cwd: string | undefined): ContextRoutingInspection {
	for (const call of findCalls(code, ["print", "display", "stdout.write", "sys.stdout.write"])) {
		if (isWholeFilePrint(call.argumentsText, cwd)) {
			return {
				decision: "block",
				pattern: "python whole-file print",
				reason:
					"Printing an unbounded Python file read would expand context; use a bounded slice or stat-able small file.",
			};
		}
	}
	return { decision: "allow", reason: "No high-confidence broad-read pattern recognized." };
}

/**
 * Inspect one IPython cell without executing it. This is intentionally
 * conservative: unknown syntax is allowed rather than treated as a violation.
 */
export function inspectContextRoutingCode(code: string, cwd?: string): ContextRoutingInspection {
	if (hasLeadingMarker(code, BYPASS_MARKER_PATTERN)) {
		return { decision: "allow", reason: "Explicit context-routing bypass marker." };
	}
	if (hasFallbackGuard(code)) {
		return { decision: "allow", reason: "Unavailable-integration fallback detected." };
	}
	const bashCell = parseBashCell(code);
	return bashCell ? inspectBashCell(bashCell, cwd) : inspectPythonCode(code, cwd);
}

function formatStats(mode: ContextRoutingMode, stats: ContextRoutingStats): string {
	return `Context routing: ${mode}; turns guided ${stats.turnsGuided}; cells inspected ${stats.cellsInspected}; allowed ${stats.allowed}; blocked ${stats.blocked}`;
}

/** Install the example policy and return live counters for tests or telemetry. */
export function installContextRouting(
	pi: ExtensionAPI,
	options: ContextRoutingInstallOptions = {},
): ContextRoutingStats {
	pi.registerFlag(CONTEXT_ROUTING_FLAG, {
		description: "Context routing: off, advisory, or strict-large-read",
		type: "string",
		default: "off",
	});
	pi.registerFlag(CONTEXT_ROUTING_FAST_REINDEX_FLAG, {
		description: "Advisory jCodeMunch fast reindex: on or off",
		type: "string",
		default: "on",
	});

	let mode = normalizeMode(pi.getFlag(CONTEXT_ROUTING_FLAG));
	const fastReindexQueue =
		options.fastReindex === false || !normalizeFastReindexFlag(pi.getFlag(CONTEXT_ROUTING_FAST_REINDEX_FLAG))
			? undefined
			: createFastReindexQueue({
					command: options.fastReindexCommand,
					concurrency: options.fastReindexConcurrency,
					reindexFile: options.reindexFile,
				});
	const stats: ContextRoutingStats = { turnsGuided: 0, cellsInspected: 0, allowed: 0, blocked: 0 };
	const emit = (event: ContextRoutingTelemetryEvent) => {
		try {
			options.telemetry?.(event);
		} catch {
			// Telemetry must never change routing behavior.
		}
	};

	pi.registerCommand("context-routing", {
		description: "Set or inspect context-routing mode",
		getArgumentCompletions: (prefix) =>
			[...CONTEXT_ROUTING_MODES, "stats"]
				.filter((candidate) => candidate.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value === "stats" || value === "") {
				ctx.ui.notify(formatStats(mode, stats), "info");
				return;
			}
			if (!(CONTEXT_ROUTING_MODES as readonly string[]).includes(value)) {
				ctx.ui.notify(`Unknown context-routing mode: ${value}`, "warning");
				return;
			}
			mode = value as ContextRoutingMode;
			ctx.ui.notify(`Context routing set to ${mode}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (mode === "off") return;
		stats.turnsGuided += 1;
		emit({ kind: "turn-guidance", mode, action: "advisory" });
		const strictLine =
			mode === "strict-large-read"
				? "Strict-large-read blocks only recognized raw curl/wget stdout, broad cat dumps, and immediately printed unbounded Python reads."
				: "This is advisory guidance; direct bounded reads are allowed.";
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Context routing (${mode})\nBefore opening whole source files, use jCodeMunch. Use Context Mode for web pages, docs, logs, and large data. Direct bounded reads are fine. Keep edits, tests, builds, and git work in Prime Agent. ${strictLine} This is routing guidance, not security.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "strict-large-read" || event.toolName !== "ipython") return undefined;
		const code = event.input.code;
		if (typeof code !== "string") return undefined;
		stats.cellsInspected += 1;
		const inspection = inspectContextRoutingCode(code, ctx.cwd);
		stats[inspection.decision === "block" ? "blocked" : "allowed"] += 1;
		emit({
			kind: "inspection",
			mode,
			action: inspection.decision,
			pattern: inspection.pattern,
		});
		if (inspection.decision === "block")
			return {
				block: true,
				reason: `${inspection.reason} Add '# context-routing: bypass' as the first non-blank line to proceed explicitly.`,
			};
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!fastReindexQueue || event.toolName !== "ipython") return;
		const ipythonEvent = event as IpythonToolResultEvent;
		if (ipythonEvent.isError || ipythonEvent.details?.status !== "ok") return;
		const paths = new Set<string>();
		for (const diff of ipythonEvent.details.diffs ?? []) {
			const absolutePath = resolveFastReindexPath(diff.path, ctx.cwd);
			if (absolutePath) paths.add(absolutePath);
		}
		if (paths.size > 0) fastReindexQueue.enqueue([...paths], ctx.cwd);
	});

	return stats;
}

export default function contextRoutingExtension(pi: ExtensionAPI): void {
	installContextRouting(pi);
}

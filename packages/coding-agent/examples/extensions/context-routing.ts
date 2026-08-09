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

export type ContextRoutingPattern =
	| "curl/wget stdout"
	| "cat whole-file dump"
	| "python whole-file print"
	| "unbounded head/tail reader";

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

interface GuardedRange {
	start: number;
	end: number;
}

interface ShellSegment {
	text: string;
	start: number;
	end: number;
	separatorBefore?: "&&" | "||" | "newline" | ";";
}

interface ShellStage {
	text: string;
	start: number;
	end: number;
}

type RedirectSafety = "none" | "safe" | "unsafe";

interface ShellRedirections {
	stdout: RedirectSafety;
	ranges: Array<{ start: number; end: number }>;
}

const BASH_CELL_PATTERN = /^(?:[ \t]*\r?\n)*[ \t]*%%bash\b[^\r\n]*(?:\r?\n|$)/;
const BYPASS_MARKER_PATTERN = /^#\s*context-routing\s*:\s*(?:allow|bypass)\s*$/i;
const FALLBACK_MARKER_PATTERN = /^#\s*context-routing\s*:\s*fallback\s*$/i;
const INTEGRATION_IDENTIFIER_PATTERN = /^(?:jcodemunch(?:-mcp)?|context[-_ ]?mode|mcp(?:[-_][a-z0-9_-]+)?)$/i;
const SHELL_KEYWORD_PATTERN = /^(?:(?:if|then|else|elif|do|while|until|for|case|!)\s+)+/i;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]*|"[^"]*"|'[^']*')\s+/;
const HEAD_REQUEST_PATTERN = /(?:^|\s)(?:-I|--head)(?=\s|$)/i;

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

function parseBashCell(code: string): ParsedBashCell | undefined {
	const match = BASH_CELL_PATTERN.exec(code);
	if (!match) return undefined;
	return { body: code.slice(match[0].length) };
}

function maskRanges(source: string, ranges: readonly GuardedRange[]): string {
	if (ranges.length === 0) return source;
	const characters = source.split("");
	for (const range of ranges) {
		for (let index = Math.max(0, range.start); index < Math.min(characters.length, range.end); index += 1) {
			if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
		}
	}
	return characters.join("");
}

function lineRanges(source: string): Array<{ start: number; end: number; text: string }> {
	const ranges: Array<{ start: number; end: number; text: string }> = [];
	let start = 0;
	for (const match of source.matchAll(/.*(?:\r?\n|$)/g)) {
		const text = match[0];
		if (text.length === 0) break;
		const end = start + text.length;
		ranges.push({ start, end, text: text.replace(/\r?\n$/, "") });
		start = end;
	}
	return ranges;
}

function findFallbackMarkerRanges(source: string): GuardedRange[] {
	const lines = lineRanges(source);
	const ranges: GuardedRange[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!FALLBACK_MARKER_PATTERN.test(lines[index]!.text.trim())) continue;
		let next = index + 1;
		while (next < lines.length && lines[next]!.text.trim().length === 0) next += 1;
		if (next >= lines.length) continue;
		const markerIndent = lines[index]!.text.match(/^\s*/)?.[0].length ?? 0;
		const nextIndent = lines[next]!.text.match(/^\s*/)?.[0].length ?? 0;
		let end = lines[next]!.end;
		for (let continuation = next + 1; continuation < lines.length; continuation += 1) {
			const text = lines[continuation]!.text;
			const indent = text.match(/^\s*/)?.[0].length ?? 0;
			if (text.trim().length > 0 && indent <= markerIndent && indent <= nextIndent) break;
			end = lines[continuation]!.end;
		}
		ranges.push({ start: lines[next]!.start, end });
	}
	return ranges;
}

function splitShellSegments(body: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let start = 0;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let separatorBefore: ShellSegment["separatorBefore"];

	const push = (end: number) => {
		const raw = body.slice(start, end);
		const leading = raw.match(/^\s*/)?.[0].length ?? 0;
		const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
		const trimmedStart = start + leading;
		const trimmedEnd = Math.max(trimmedStart, end - trailing);
		if (trimmedEnd > trimmedStart) {
			segments.push({
				text: body.slice(trimmedStart, trimmedEnd),
				start: trimmedStart,
				end: trimmedEnd,
				separatorBefore,
			});
		}
		start = end;
		separatorBefore = undefined;
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
		if (character === "\n" || character === ";") {
			push(index);
			separatorBefore = character === ";" ? ";" : "newline";
			start = index + 1;
			continue;
		}
		if ((character === "&" || character === "|") && body[index + 1] === character) {
			push(index);
			separatorBefore = character === "&" ? "&&" : "||";
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

	const trimmed = text.trim();
	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index];
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
		if (character === "#" && (index === 0 || /\s/.test(trimmed[index - 1] ?? ""))) break;
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

function splitPipelineStages(text: string, offset: number): ShellStage[] {
	const stages: ShellStage[] = [];
	let start = 0;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	const push = (end: number) => {
		const raw = text.slice(start, end);
		const leading = raw.match(/^\s*/)?.[0].length ?? 0;
		const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
		const stageStart = start + leading;
		const stageEnd = Math.max(stageStart, end - trailing);
		if (stageEnd > stageStart)
			stages.push({ text: text.slice(stageStart, stageEnd), start: offset + stageStart, end: offset + stageEnd });
		start = end;
	};
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
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
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === "#" && (index === 0 || /\s/.test(text[index - 1] ?? ""))) break;
		else if (character === "|" && text[index + 1] !== "|") {
			push(index);
			if (text[index + 1] === "&") index += 1;
			start = index + 1;
		}
	}
	push(text.length);
	return stages;
}

function readShellToken(source: string, start: number): { end: number; value: string } | undefined {
	let index = start;
	while (/\s/.test(source[index] ?? "")) index += 1;
	if (index >= source.length || /[;|&]/.test(source[index] ?? "")) return undefined;
	const valueStart = index;
	let value = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else value += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else value += character;
			continue;
		}
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (/\s|[;|&]/.test(character)) break;
		else value += character;
	}
	return { end: index === valueStart ? index + 1 : index, value };
}

function entersDescriptorNamespace(target: string): boolean {
	const components: string[] = [];
	for (const component of target.split("/")) {
		if (!component || component === ".") continue;
		if (component === "..") {
			components.pop();
			continue;
		}
		components.push(component);
		if (components[0] === "dev" && components[1] === "fd") return true;
		if (
			components[0] === "proc" &&
			/^(?:self|thread-self|\d+)$/.test(components[1] ?? "") &&
			(components[2] === "fd" ||
				(components[2] === "task" && /^\d+$/.test(components[3] ?? "") && components[4] === "fd"))
		)
			return true;
	}
	return false;
}

function isSafeRedirectTarget(target: string | undefined, cwd: string | undefined): boolean {
	if (!target || target === "-" || target.startsWith("&") || target.startsWith("~")) return false;
	if (/^\d+$/.test(target)) return false;
	if (entersDescriptorNamespace(target)) return false;
	const normalized = target.startsWith("/")
		? path.posix.normalize(target)
		: cwd
			? path.posix.resolve(cwd, target)
			: target;
	if (/^\/dev\/null$/.test(normalized)) return true;
	if (/^\d+$/.test(normalized) || /^\/dev\/(?:stdin|stdout|stderr|fd\/\d+)$/.test(normalized)) return false;
	if (normalized === "/proc" || normalized.startsWith("/proc/")) return false;
	return !normalized.startsWith("~") && !/[$`*?{}<>|;]/.test(normalized);
}

function parseShellRedirections(text: string, cwd: string | undefined): ShellRedirections {
	const ranges: Array<{ start: number; end: number }> = [];
	let stdout: RedirectSafety = "none";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
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
		if (character === "#" && (index === 0 || /\s/.test(text[index - 1] ?? ""))) break;
		let start = index;
		let fd: number | "all" | undefined;
		let operatorEnd: number | undefined;
		if (character === "&" && text[index + 1] === ">") {
			fd = "all";
			operatorEnd = index + (text[index + 2] === ">" ? 3 : 2);
		} else if (character === ">") {
			operatorEnd = index + (text[index + 1] === ">" ? 2 : 1);
			if (text[operatorEnd] === "&") operatorEnd += 1;
			let digitStart = index;
			while (digitStart > 0 && /\d/.test(text[digitStart - 1] ?? "")) digitStart -= 1;
			if (digitStart < index && (digitStart === 0 || /\s|[;|&]/.test(text[digitStart - 1] ?? ""))) {
				start = digitStart;
				fd = Number(text.slice(digitStart, index));
			}
		}
		if (operatorEnd === undefined) continue;
		const target = readShellToken(text, operatorEnd);
		const safe = isSafeRedirectTarget(target?.value, cwd);
		ranges.push({ start, end: target?.end ?? operatorEnd });
		if (fd === undefined || fd === 1 || fd === "all") stdout = safe ? "safe" : "unsafe";
		index = (target?.end ?? operatorEnd) - 1;
	}
	return { stdout, ranges };
}

function shellWordsWithoutRedirections(text: string, redirections: ShellRedirections): string[] {
	return shellWords(maskRanges(text, redirections.ranges));
}

function classifyOutputTarget(target: string | undefined, cwd: string | undefined): RedirectSafety {
	return isSafeRedirectTarget(target, cwd) ? "safe" : "unsafe";
}

function outputOptionSafety(words: string[], executable: string, cwd: string | undefined): RedirectSafety {
	let result: RedirectSafety = "none";
	const isCurl = executable === "curl" || executable === "curl.exe";
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]!;
		if (isCurl && (word === "-O" || word === "--remote-name")) {
			result = "safe";
			continue;
		}
		if (isCurl && /^--(?:output|output-document)=/.test(word)) {
			result = classifyOutputTarget(word.slice(word.indexOf("=") + 1), cwd);
			continue;
		}
		if (isCurl && /^-o.+/.test(word)) {
			result = classifyOutputTarget(word.slice(2), cwd);
			continue;
		}
		if (isCurl && (word === "-o" || word === "--output" || word === "--output-document")) {
			result = classifyOutputTarget(words[++index], cwd);
			continue;
		}
		if (!isCurl && word === "-O") {
			result = classifyOutputTarget(words[++index], cwd);
			continue;
		}
		if (!isCurl && /^--output-document=/.test(word)) {
			result = classifyOutputTarget(word.slice(word.indexOf("=") + 1), cwd);
			continue;
		}
		if (!isCurl && /^-[A-Za-z]*O(?:.+)?$/.test(word)) {
			const target = word.replace(/^-.*?O/, "");
			result = classifyOutputTarget(target || words[++index], cwd);
		}
	}
	return result;
}

function limiterInfo(words: string[]): { isLimiter: boolean; bounded: boolean } {
	const executable = words[0]?.toLowerCase();
	if (executable !== "head" && executable !== "head.exe" && executable !== "tail" && executable !== "tail.exe") {
		return { isLimiter: false, bounded: false };
	}
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]!;
		const inline = /^(?:--(?:lines|bytes)=|-?[nc])(.+)$/.exec(word);
		if (word === "-n" || word === "-c" || word === "--lines" || word === "--bytes") {
			const value = words[++index];
			return { isLimiter: true, bounded: /^\d+$/.test(value ?? "") };
		}
		if (/^\+[0-9]+$/.test(word)) return { isLimiter: true, bounded: false };
		if (/^-[nc]\d+$/.test(word) || /^-\d+$/.test(word)) return { isLimiter: true, bounded: true };
		if (inline) return { isLimiter: true, bounded: /^\d+$/.test(inline[1] ?? "") };
	}
	return { isLimiter: true, bounded: true };
}

function isPassThroughPipelineStage(words: string[]): boolean {
	const executable = words[0]?.toLowerCase();
	if (!executable) return false;
	if ((executable === "cat" || executable === "cat.exe") && words.length === 1) return true;
	if (executable === "tee" || executable === "tee.exe" || executable === "wc" || executable === "wc.exe") return true;
	if (executable === "tr" || executable === "tr.exe") return true;

	const hasNoInputFile = (consumingOptions: ReadonlySet<string>, maxExpressions: number): boolean => {
		let expressions = 0;
		for (let index = 1; index < words.length; index += 1) {
			const word = words[index]!;
			if (word === "--") return index + 1 === words.length;
			if (word.startsWith("-")) {
				if (consumingOptions.has(word)) index += 1;
				continue;
			}
			expressions += 1;
			if (expressions > maxExpressions) return false;
		}
		return true;
	};

	if (executable === "grep" || executable === "grep.exe" || executable === "egrep" || executable === "fgrep") {
		let hasPattern = false;
		for (let index = 1; index < words.length; index += 1) {
			const word = words[index]!;
			if (word === "--") {
				if (hasPattern && index + 1 < words.length) return false;
				continue;
			}
			if (word === "-e" || word === "--regexp" || word === "-f" || word === "--file") {
				hasPattern = true;
				index += 1;
				continue;
			}
			if (word.startsWith("-")) continue;
			if (hasPattern) return false;
			hasPattern = true;
		}
		return true;
	}
	if (executable === "sed" || executable === "sed.exe") {
		return hasNoInputFile(new Set(["-e", "--expression", "-f", "--file"]), 1);
	}
	if (executable === "awk" || executable === "gawk") return hasNoInputFile(new Set(["-f", "--file"]), 1);
	if (executable === "cut")
		return hasNoInputFile(new Set(["-b", "-c", "-d", "-f", "--bytes", "--characters", "--delimiter", "--fields"]), 0);
	if (executable === "sort" || executable === "uniq" || executable === "fold" || executable === "fmt") {
		return hasNoInputFile(new Set(), 0);
	}
	return false;
}

function boundedPipelineLimiter(stages: ShellStage[], cwd: string | undefined): number | undefined {
	let lastLimiter: number | undefined;
	let lastLimiterBounded = false;
	for (let index = 0; index < stages.length; index += 1) {
		const redirections = parseShellRedirections(stages[index]!.text, cwd);
		const words = shellWordsWithoutRedirections(stages[index]!.text, redirections);
		const info = limiterInfo(words);
		if (info.isLimiter) {
			lastLimiter = index;
			lastLimiterBounded = info.bounded;
		}
	}
	if (lastLimiter === undefined || !lastLimiterBounded) return undefined;
	for (let index = lastLimiter + 1; index < stages.length; index += 1) {
		const redirections = parseShellRedirections(stages[index]!.text, cwd);
		if (!isPassThroughPipelineStage(shellWordsWithoutRedirections(stages[index]!.text, redirections)))
			return undefined;
	}
	return lastLimiter;
}

function shellAvailabilityCheck(text: string): boolean {
	const command = commandAfterShellPreamble(text);
	const match = /^(?:command\s+-v|which)\s+([^\s;&|]+)/i.exec(command);
	return match !== null && INTEGRATION_IDENTIFIER_PATTERN.test(match[1] ?? "");
}

function findShellFallbackRanges(body: string, segments: readonly ShellSegment[]): GuardedRange[] {
	const ranges = findFallbackMarkerRanges(body);
	for (let index = 1; index < segments.length; index += 1) {
		if (segments[index]!.separatorBefore !== "||" || !shellAvailabilityCheck(segments[index - 1]!.text)) continue;
		ranges.push({ start: segments[index]!.start, end: segments[index]!.end });
	}
	return ranges;
}

function inspectBashCell(
	cell: ParsedBashCell,
	cwd: string | undefined,
	guardedRanges: readonly GuardedRange[],
): ContextRoutingInspection {
	const segments = splitShellSegments(cell.body);
	for (const segment of segments) {
		if (guardedRanges.some((range) => segment.start >= range.start && segment.start < range.end)) continue;
		const stages = splitPipelineStages(segment.text, segment.start);
		const limiter = boundedPipelineLimiter(stages, cwd);
		for (let index = 0; index < stages.length; index += 1) {
			const stage = stages[index]!;
			const redirections = parseShellRedirections(stage.text, cwd);
			const words = shellWordsWithoutRedirections(stage.text, redirections);
			const command = commandAfterShellPreamble(words.join(" "));
			const executable = command.split(/\s+/, 1)[0]?.toLowerCase();
			if (!executable) continue;
			const directLimiter = limiterInfo(words);
			const pipelineBounded = limiter !== undefined && index <= limiter && redirections.stdout !== "unsafe";
			if (directLimiter.isLimiter && !directLimiter.bounded && !pipelineBounded) {
				return {
					decision: "block",
					pattern: "unbounded head/tail reader",
					reason: "An unbounded head/tail read would expand context; use a numeric bound or a bounded pipeline.",
				};
			}
			if (
				redirections.stdout === "safe" ||
				pipelineBounded ||
				(limiter !== undefined && index > limiter && isPassThroughPipelineStage(words))
			)
				continue;

			if ((executable === "curl" || executable === "curl.exe") && !HEAD_REQUEST_PATTERN.test(command)) {
				if (outputOptionSafety(words, executable, cwd) !== "safe") {
					return {
						decision: "block",
						pattern: "curl/wget stdout",
						reason: "Raw curl output would expand context; redirect it to a real file or use a bounded parser.",
					};
				}
			}

			if (executable === "wget" || executable === "wget.exe") {
				if (outputOptionSafety(words, executable, cwd) !== "safe") {
					return {
						decision: "block",
						pattern: "curl/wget stdout",
						reason: "Raw wget output would expand context; redirect it to a real file or use a bounded parser.",
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
	}
	return { decision: "allow", reason: "No high-confidence broad-read pattern recognized." };
}

interface CallExpression {
	name: string;
	argumentsText: string;
	start: number;
	open: number;
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
		if (!identifier || !names.some((name) => identifier === name || identifier.endsWith(`.${name}`))) continue;
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
			calls.push({
				name: identifier,
				argumentsText: source.slice(open + 1, end - 1),
				start: index,
				open,
				end,
			});
			index = end - 1;
		}
	}
	return calls;
}

function extractLiteralPath(expression: string): string | undefined {
	const match = /\b(?:Path|open)\s*\(\s*(["'])([^"']+)\1/.exec(expression);
	if (match) return match[2];
	return /^\s*(["'])([^"']+)\1/.exec(expression)?.[2];
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

function isReadCallBounded(call: CallExpression): boolean {
	return call.name === "read" && /^\s*\d+\s*$/.test(call.argumentsText);
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string): number | undefined {
	let depth = 0;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
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
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === open) depth += 1;
		else if (character === close) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return undefined;
}

function isBoundedSliceAfterRead(expression: string, call: CallExpression): boolean {
	let index = call.end;
	while (/\s/.test(expression[index] ?? "")) index += 1;
	if (expression[index] !== "[") return false;
	const close = findMatchingDelimiter(expression, index, "[", "]");
	if (close === undefined) return false;
	const slice = expression.slice(index + 1, close).trim();
	if (!slice.includes(":")) return /^\d+$/.test(slice);
	const upper = slice.split(":", 2)[1]?.trim() ?? "";
	return /^\d+$/.test(upper);
}

function splitPythonArguments(source: string): string[] {
	const argumentsText: string[] = [];
	let start = 0;
	let parens = 0;
	let brackets = 0;
	let braces = 0;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
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
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		else if (character === "(") parens += 1;
		else if (character === ")") parens -= 1;
		else if (character === "[") brackets += 1;
		else if (character === "]") brackets -= 1;
		else if (character === "{") braces += 1;
		else if (character === "}") braces -= 1;
		else if (character === "," && parens === 0 && brackets === 0 && braces === 0) {
			argumentsText.push(source.slice(start, index));
			start = index + 1;
		}
	}
	argumentsText.push(source.slice(start));
	return argumentsText;
}

function resolvePathForRead(expression: string, read: CallExpression): string | undefined {
	const pathCalls = findCalls(expression, ["open", "Path"])
		.filter((call) => call.end <= read.start && /^\s*\.\s*$/.test(expression.slice(call.end, read.start)))
		.sort((left, right) => right.end - left.end);
	return pathCalls.length > 0 ? extractLiteralPath(pathCalls[0]!.argumentsText) : undefined;
}

function pythonDelimiterDepths(source: string): number[] {
	const depths = new Array<number>(source.length + 1).fill(0);
	let depth = 0;
	for (let index = 0; index < source.length; index += 1) {
		depths[index] = depth;
		if (/[([{]/.test(source[index] ?? "")) depth += 1;
		else if (source[index] === ")" || source[index] === "]" || source[index] === "}") depth = Math.max(0, depth - 1);
	}
	depths[source.length] = depth;
	return depths;
}

function hasScalarBoundary(masked: string, start: number, end: number, depths: number[], maxDepth: number): boolean {
	for (let index = start; index < end; index += 1) {
		if ((depths[index] ?? 0) > maxDepth) continue;
		if (masked[index] === ",") return true;
		const keyword = /[A-Za-z_]/.test(masked[index] ?? "")
			? /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(index))?.[0]
			: undefined;
		if (keyword && /^(?:and|or|if|else|for)$/.test(keyword)) return true;
		if (keyword) index += keyword.length - 1;
	}
	return false;
}

function comparisonConsumesRead(masked: string, read: CallExpression): boolean {
	const depths = pythonDelimiterDepths(masked);
	const comparisons = /(?:\bnot\s+in\b|\bis(?:\s+not)?\b|==|!=|<=|>=|<|>|\bin\b)/g;
	for (const match of masked.matchAll(comparisons)) {
		const operatorStart = match.index ?? 0;
		const operatorEnd = operatorStart + match[0].length;
		const readDepth = depths[read.start] ?? 0;
		const operatorDepth = depths[operatorStart] ?? 0;
		if (operatorDepth > readDepth) continue;
		const readIsLeftOperand = read.end <= operatorStart;
		const readIsRightOperand = read.start >= operatorEnd;
		if (!readIsLeftOperand && !readIsRightOperand) continue;
		const gapStart = readIsLeftOperand ? read.end : operatorEnd;
		const gapEnd = readIsLeftOperand ? operatorStart : read.start;
		const sharedDepth = Math.min(depths[read.start] ?? 0, depths[operatorStart] ?? 0);
		if (!hasScalarBoundary(masked, gapStart, gapEnd, depths, sharedDepth)) return true;
	}
	return false;
}

function readHasScalarReducerAncestor(expression: string, read: CallExpression): boolean {
	const scalarReducers = findCalls(expression, ["len", "hash", "sum", "bool", "any", "all"]);
	return scalarReducers.some((call) => call.start < read.start && call.end >= read.end);
}

function readIsScalar(expression: string, read: CallExpression): boolean {
	const masked = maskPythonStrings(expression);
	if (comparisonConsumesRead(masked, read)) return true;
	if (readHasScalarReducerAncestor(expression, read)) return true;
	let after = read.end;
	while (/\s/.test(expression[after] ?? "")) after += 1;
	return /^(?:\.\s*(?:count|find|index|startswith|endswith|isascii)\s*\()/.test(expression.slice(after));
}

function isWholeFileReadExpression(expression: string, cwd: string | undefined): boolean {
	const reads = findCalls(expression, ["read", "read_text"]);
	for (const read of reads) {
		if (isReadCallBounded(read) || isBoundedSliceAfterRead(expression, read) || readIsScalar(expression, read))
			continue;
		const fileName = resolvePathForRead(expression, read);
		if (!resolveSmallFile(fileName, cwd)) return true;
	}
	return false;
}

function findFStringInterpolations(source: string): string[] {
	const interpolations: string[] = [];
	for (let index = 0; index < source.length; index += 1) {
		if (!/[fF]/.test(source[index] ?? "") || (index > 0 && /[A-Za-z0-9_]/.test(source[index - 1] ?? ""))) continue;
		const quoteIndex = source[index + 1] === "r" || source[index + 1] === "R" ? index + 2 : index + 1;
		const quote = source[quoteIndex];
		if (quote !== "'" && quote !== '"') continue;
		const end = skipPythonString(source, quoteIndex);
		const content = source.slice(quoteIndex + 1, Math.max(quoteIndex + 1, end - 1));
		for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
			if (content[contentIndex] !== "{" || content[contentIndex + 1] === "{") continue;
			const close = findMatchingDelimiter(content, contentIndex, "{", "}");
			if (close === undefined) break;
			interpolations.push(content.slice(contentIndex + 1, close));
			contentIndex = close;
		}
		index = Math.max(index, end - 1);
	}
	return interpolations;
}

function isWholeFilePrint(expression: string, cwd: string | undefined): boolean {
	for (const argument of splitPythonArguments(expression)) {
		if (isWholeFileReadExpression(argument, cwd)) return true;
		if (findFStringInterpolations(argument).some((interpolation) => isWholeFileReadExpression(interpolation, cwd)))
			return true;
	}
	return false;
}

function hasIntegrationIdentifier(text: string): boolean {
	return maskPythonStrings(text)
		.split(/\s+/)
		.some((word) => INTEGRATION_IDENTIFIER_PATTERN.test(word.replace(/[^A-Za-z0-9_-]/g, "")));
}

function findPythonFallbackRanges(code: string): GuardedRange[] {
	const lines = lineRanges(code);
	const ranges = findFallbackMarkerRanges(code);
	for (let index = 0; index < lines.length; index += 1) {
		const tryMatch = /^(\s*)try\s*:\s*$/.exec(lines[index]!.text);
		if (!tryMatch) continue;
		const tryIndent = tryMatch[1]!.length;
		let exceptIndex = index + 1;
		while (exceptIndex < lines.length) {
			const line = lines[exceptIndex]!.text;
			const indent = line.match(/^\s*/)?.[0].length ?? 0;
			if (line.trim().length > 0 && indent <= tryIndent) {
				if (
					indent === tryIndent &&
					/^except\s+\(?[^:]*\b(?:ImportError|ModuleNotFoundError)\b[^:]*\)?\s*:/.test(line.trim())
				)
					break;
				if (indent < tryIndent) break;
			}
			exceptIndex += 1;
		}
		if (exceptIndex >= lines.length) continue;
		let end = lines[exceptIndex]!.end;
		for (let bodyIndex = exceptIndex + 1; bodyIndex < lines.length; bodyIndex += 1) {
			const line = lines[bodyIndex]!.text;
			const indent = line.match(/^\s*/)?.[0].length ?? 0;
			if (line.trim().length > 0 && indent <= tryIndent) break;
			end = lines[bodyIndex]!.end;
		}
		const guardedText = code.slice(lines[index]!.start, end);
		if (hasIntegrationIdentifier(guardedText)) ranges.push({ start: lines[exceptIndex]!.start, end });
	}
	return ranges;
}

function inspectPythonCode(
	code: string,
	cwd: string | undefined,
	guardedRanges: readonly GuardedRange[],
): ContextRoutingInspection {
	const inspectedCode = maskRanges(code, guardedRanges);
	for (const call of findCalls(inspectedCode, ["print", "display", "stdout.write", "sys.stdout.write"])) {
		if (isWholeFilePrint(inspectedCode.slice(call.start, call.end), cwd)) {
			return {
				decision: "block",
				pattern: "python whole-file print",
				reason:
					"Printing an unbounded Python file read would expand context; use a bounded slice, a scalar reducer, or a stat-able small file.",
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
	const bashCell = parseBashCell(code);
	if (bashCell) {
		const segments = splitShellSegments(bashCell.body);
		const guardedRanges = findShellFallbackRanges(bashCell.body, segments);
		return inspectBashCell(bashCell, cwd, guardedRanges);
	}
	return inspectPythonCode(code, cwd, findPythonFallbackRanges(code));
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

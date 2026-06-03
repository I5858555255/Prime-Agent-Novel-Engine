import { describe, expect, test } from "vitest";
import {
	type AppMode,
	type DaemonInteractiveSessionManagerDecision,
	type InteractiveDaemonStartupDecision,
	parseDaemonRichTuiAttachShortcut,
	shouldUseDaemonInteractive,
	shouldUseEphemeralSessionManagerForDaemonInteractive,
} from "../src/main.js";

describe("interactive startup routing", () => {
	test("uses daemon-backed interactive mode for normal interactive startup", () => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
			}),
		).toBe(true);
	});

	const nonInteractiveModes: Array<[AppMode, string]> = [
		["print", "print mode"],
		["json", "json mode"],
		["rpc", "rpc mode"],
		["daemon", "daemon mode"],
	];

	test.each(nonInteractiveModes)("does not use daemon-backed interactive mode for %s", (appMode) => {
		expect(
			shouldUseDaemonInteractive({
				appMode,
				startupBenchmark: false,
			}),
		).toBe(false);
	});

	type InteractiveFallbackOverrides = Partial<
		Pick<InteractiveDaemonStartupDecision, "startupBenchmark" | "noSession" | "help" | "listModels">
	>;

	const fallbackCases: Array<[string, InteractiveFallbackOverrides]> = [
		["startup benchmark", { startupBenchmark: true }],
		["--no-session", { noSession: true }],
		["--help", { help: true }],
		["--list-models", { listModels: true }],
		["--list-models search", { listModels: "claude" }],
	];

	test.each(fallbackCases)("keeps %s on the non-daemon interactive path", (_label, overrides) => {
		expect(
			shouldUseDaemonInteractive({
				appMode: "interactive",
				startupBenchmark: false,
				...overrides,
			}),
		).toBe(false);
	});
});

describe("daemon-backed interactive session manager routing", () => {
	test("uses an ephemeral local session manager for fresh daemon-owned sessions", () => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive({})).toBe(true);
	});

	const persistentSelectionCases: Array<[string, DaemonInteractiveSessionManagerDecision]> = [
		["active daemon attach", { hasActiveDaemonSession: true }],
		["explicit saved session", { session: "saved-session-id" }],
		["resume picker", { resume: true }],
		["continue recent", { continue: true }],
		["fork", { fork: "source-session-id" }],
	];

	test.each(persistentSelectionCases)("keeps %s on a concrete local session manager", (_label, decision) => {
		expect(shouldUseEphemeralSessionManagerForDaemonInteractive(decision)).toBe(false);
	});
});

describe("daemon rich TUI attach shortcut parsing", () => {
	test("recognizes daemon active-session shorthand", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "d5c1e83e2182"])).toMatchObject({
			selector: "d5c1e83e2182",
		});
	});

	test("preserves explicit daemon client commands", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "attach", "d5c1e83e2182"])).toBeUndefined();
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "list"])).toBeUndefined();
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "create", "scratch"])).toBeUndefined();
	});

	test("carries daemon socket option into shorthand attach", () => {
		expect(parseDaemonRichTuiAttachShortcut(["daemon", "--socket", "/tmp/prime.sock", "d5c1e83e2182"])).toEqual({
			socketPath: "/tmp/prime.sock",
			selector: "d5c1e83e2182",
		});
	});
});

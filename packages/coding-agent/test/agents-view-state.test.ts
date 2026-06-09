import { describe, expect, test, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import { resolveAgentsViewSessionUiServices } from "../src/modes/agents-view/agents-view-mode.js";
import {
	buildAgentsViewRows,
	classifyAgentsViewSession,
	type SessionSummary,
	shouldShowAgentsViewSession,
} from "../src/modes/index.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

describe("agents view state", () => {
	test("classifies active daemon sessions into coarse fleet sections", () => {
		expect(classifyAgentsViewSession(makeSummary({ isStreaming: true, status: "model" }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ pendingMessageCount: 1 }))).toBe("working");
		expect(classifyAgentsViewSession(makeSummary({ status: "user", messageCount: 2 }))).toBe("needs_input");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", messageCount: 0 }))).toBe("needs_input");
		expect(classifyAgentsViewSession(makeSummary({ status: "idle", messageCount: 4 }))).toBe("completed");
	});

	test("sorts rows by section and most recent modified time", () => {
		const rows = buildAgentsViewRows([
			makeSummary({ sessionName: "completed", status: "idle", messageCount: 2, modified: "2026-01-01T00:00:00Z" }),
			makeSummary({ sessionName: "working", isStreaming: true, modified: "2026-01-01T00:00:00Z" }),
			makeSummary({ sessionName: "older input", status: "user", modified: "2026-01-01T00:00:00Z" }),
			makeSummary({ sessionName: "newer input", status: "user", modified: "2026-01-02T00:00:00Z" }),
		]);

		expect(rows.map((row) => row.title)).toEqual(["newer input", "older input", "working", "completed"]);
		expect(rows.map((row) => row.section)).toEqual(["needs_input", "needs_input", "working", "completed"]);
	});

	test("summarizes subagents on their parent and omits subagent rows", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				isStreaming: true,
				status: "model",
			}),
			makeSummary({
				id: "second-child-active",
				activeSessionId: "second-child-active",
				sessionId: "second-child-session",
				sessionName: "Second child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				status: "tool",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				status: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				status: "tool",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				status: "idle",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => row.title)).toEqual(["Parent", "Other"]);
		expect(rows.map((row) => row.runningSubagentCount)).toEqual([2, 0]);
		expect(rows.map((row) => row.depth)).toEqual([0, 0]);
		expect(rows.map((row) => row.selectable)).toEqual([true, true]);
	});

	test("hides inactive hidden sessions while keeping active sessions visible", () => {
		const inactiveHidden = makeSummary({ status: "hidden" });
		const staleDaemonHidden = makeSummary({ status: "sleep" });
		delete inactiveHidden.activeSessionId;
		delete staleDaemonHidden.activeSessionId;

		expect(shouldShowAgentsViewSession(inactiveHidden)).toBe(false);
		expect(shouldShowAgentsViewSession(staleDaemonHidden, "hidden")).toBe(false);
		expect(shouldShowAgentsViewSession(makeSummary({ status: "idle" }), undefined, true)).toBe(false);
		expect(shouldShowAgentsViewSession(makeSummary({ status: "hidden", activeSessionId: "active-1" }))).toBe(true);
	});

	test("uses session-specific UI services when opening an agent", async () => {
		const dashboardServices = makeUiServices("/tmp/dashboard");
		const sessionServices = makeUiServices("/tmp/project");
		const summary = makeSummary({ cwd: "/tmp/project", sessionFile: "/tmp/project/session.jsonl" });
		const createUiServicesForSession = vi.fn(async () => sessionServices);

		await expect(
			resolveAgentsViewSessionUiServices(
				{
					uiServices: dashboardServices,
					createUiServicesForSession,
				},
				summary,
			),
		).resolves.toBe(sessionServices);
		expect(createUiServicesForSession).toHaveBeenCalledWith(summary);
	});
});

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		status: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		pendingMessageCount: 0,
		...overrides,
	};
}

function makeUiServices(cwd: string): InteractiveModeUiServices {
	return {
		settingsManager: {} as SettingsManager,
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => cwd,
		getInitialSessionName: () => undefined,
		getThemes: (): Theme[] => [],
	};
}

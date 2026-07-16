import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentCronJob, AgentHeartbeatManagementAction } from "../src/core/cron-jobs.js";
import { KEYBINDINGS } from "../src/core/keybindings.js";
import type { AgentConnectionHeartbeat } from "../src/modes/agent-connection/types.js";
import { HeartbeatManagerComponent } from "../src/modes/interactive/components/heartbeat-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function heartbeat(
	id: string,
	options: Partial<AgentCronJob> & { source: "heartbeat" | "rlm_heartbeat" },
): AgentConnectionHeartbeat {
	const { source, ...overrides } = options;
	return {
		job: {
			id,
			status: "active",
			source,
			activeSessionId: `active-${id}`,
			sessionId: `session-${id}`,
			sessionFile: `/tmp/${id}.jsonl`,
			cwd: "/tmp",
			prompt: `${id} prompt`,
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: "2026-07-15T10:00:00.000Z",
			updatedAt: "2026-07-15T10:00:00.000Z",
			nextRunAt: "2026-07-15T10:05:00.000Z",
			runCount: 2,
			...overrides,
		},
		sessionName: id === "user" ? "Primary session" : "Background session",
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("HeartbeatManagerComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("uses a terminal-stable default shortcut", () => {
		expect(KEYBINDINGS["app.heartbeats.open"].defaultKeys).toBe("f6");
	});

	it("groups user and agent heartbeats and stays within terminal width", () => {
		const component = new HeartbeatManagerComponent(
			[
				heartbeat("user", { source: "heartbeat" }),
				heartbeat("agent", {
					source: "rlm_heartbeat",
					status: "paused",
					nextRunAt: undefined,
					deliveryMode: "follow_up",
					lastError: "the previous delivery failed",
				}),
			],
			{ getRows: () => 20, onAction: async () => {}, onClose: () => {}, requestRender: () => {} },
		);
		for (const width of [32, 48, 80]) {
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain("2 heartbeats · 1 paused");
		expect(output).toContain("Primary session");
		expect(output).toContain("User");
		expect(output).toContain("Agent");
		expect(output).toContain("follow-up");
		expect(output).toContain("previous delivery failed");
	});

	it("pauses and stops individual heartbeats with stop confirmation", async () => {
		const actions: Array<{ id: string; action: AgentHeartbeatManagementAction }> = [];
		const component = new HeartbeatManagerComponent([heartbeat("user", { source: "heartbeat" })], {
			getRows: () => 20,
			onAction: async (entry, action) => {
				actions.push({ id: entry.job.id, action });
			},
			onClose: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		component.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(actions).toEqual([{ id: "user", action: "pause" }]);

		component.handleInput("\r");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("\x1b[A");
		component.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(actions).toEqual([
			{ id: "user", action: "pause" },
			{ id: "user", action: "stop" },
		]);
	});
});

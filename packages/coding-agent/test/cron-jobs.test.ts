import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentCronJobStore,
	AgentCronScheduler,
	createAgentHeartbeatToolDefinitions,
	parseAgentCronSchedule,
	parseHeartbeatCommand,
} from "../src/core/cron-jobs.js";

const start = new Date("2026-01-01T12:34:00.000Z");

describe("parseAgentCronSchedule", () => {
	it("parses one-shot relative schedules", () => {
		const parsed = parseAgentCronSchedule("in 15m", start);

		expect(parsed.schedule).toEqual({ kind: "once", expression: "in 15m" });
		expect(parsed.nextRunAt.toISOString()).toBe("2026-01-01T12:49:00.000Z");
	});

	it("parses cron aliases and five-field cron subsets", () => {
		expect(parseAgentCronSchedule("@hourly", start).nextRunAt.toISOString()).toBe("2026-01-01T13:00:00.000Z");
		expect(parseAgentCronSchedule("*/30 * * * *", start).nextRunAt.toISOString()).toBe("2026-01-01T13:00:00.000Z");
	});

	it("parses recurring heartbeat intervals with seconds", () => {
		const parsed = parseAgentCronSchedule("every 30s", start);

		expect(parsed.schedule).toEqual({ kind: "interval", expression: "every 30s", intervalMs: 30_000 });
		expect(parsed.nextRunAt.toISOString()).toBe("2026-01-01T12:34:30.000Z");
	});

	it("rejects unsupported cron syntax", () => {
		expect(() => parseAgentCronSchedule("0 9 * * MON", start)).toThrow("Invalid cron number");
	});
});

describe("parseHeartbeatCommand", () => {
	it("matches the goal-style status and lifecycle commands", () => {
		expect(parseHeartbeatCommand("/heartbeat")).toEqual({ type: "status" });
		expect(parseHeartbeatCommand("/heartbeat status")).toEqual({ type: "status" });
		expect(parseHeartbeatCommand("/heartbeat pause")).toEqual({ type: "pause" });
		expect(parseHeartbeatCommand("/heartbeat resume")).toEqual({ type: "resume" });
		expect(parseHeartbeatCommand("/heartbeat clear")).toEqual({ type: "clear" });
		expect(parseHeartbeatCommand("/heartbeat stop")).toEqual({ type: "clear" });
	});

	it("defaults new heartbeat instructions to every five minutes", () => {
		expect(parseHeartbeatCommand("/heartbeat check on me")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check on me",
		});
	});

	it("accepts explicit heartbeat intervals", () => {
		expect(parseHeartbeatCommand("/heartbeat --every 30s check on me")).toEqual({
			type: "set",
			schedule: "every 30s",
			instruction: "check on me",
		});
		expect(parseHeartbeatCommand("/heartbeat every 10m -- check status")).toEqual({
			type: "set",
			schedule: "every 10m",
			instruction: "check status",
		});
	});
});

describe("AgentCronJobStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists, reloads, and cancels jobs", () => {
		const storePath = makeStorePath(tempDirs);
		const store = new AgentCronJobStore(storePath);
		const job = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "check the long run",
			now: start,
		});

		expect(job.nextRunAt).toBe("2026-01-01T13:34:00.000Z");
		expect(new AgentCronJobStore(storePath).list()).toMatchObject([
			{
				id: job.id,
				status: "active",
				prompt: "check the long run",
			},
		]);

		const cancelled = store.cancel(job.id, new Date("2026-01-01T12:40:00.000Z"));

		expect(cancelled).toMatchObject({ id: job.id, status: "cancelled" });
		expect(store.list()[0]).toMatchObject({ id: job.id, status: "cancelled" });
		expect(store.list()[0]).not.toHaveProperty("nextRunAt");
	});

	it("keeps overdue jobs eligible for the scheduler after restart", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "check the long run",
			now: start,
		});

		expect(store.nextActiveRunAt()?.toISOString()).toBe("2026-01-01T12:35:00.000Z");
	});

	it("keeps one persistent heartbeat per active session", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const first = store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});
		const second = store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "continue the work",
			now: new Date("2026-01-01T12:35:00.000Z"),
		});

		expect(store.getHeartbeat("active-1")).toMatchObject({ id: second.id, prompt: "continue the work" });
		expect(store.list().find((job) => job.id === first.id)).toMatchObject({ status: "cancelled" });
	});

	it("pauses, resumes, and clears heartbeat state", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});

		expect(store.pauseHeartbeat("active-1", new Date("2026-01-01T12:34:10.000Z"))).toMatchObject({
			id: job.id,
			status: "paused",
		});
		expect(store.getHeartbeat("active-1")).not.toHaveProperty("nextRunAt");
		expect(store.resumeHeartbeat("active-1", new Date("2026-01-01T12:35:00.000Z"))).toMatchObject({
			id: job.id,
			status: "active",
			nextRunAt: "2026-01-01T12:35:30.000Z",
		});
		expect(store.clearHeartbeat("active-1", new Date("2026-01-01T12:36:00.000Z"))).toMatchObject({
			id: job.id,
			status: "cancelled",
		});
		expect(store.getHeartbeat("active-1")).toBeUndefined();
	});

	it("rejects one-shot heartbeat schedules", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));

		expect(() =>
			store.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				scheduleText: "in 5m",
				prompt: "check on me",
				now: start,
			}),
		).toThrow("Heartbeat schedule must be recurring");
	});
});

describe("AgentCronScheduler", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs due one-shot jobs and marks them completed", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "continue the audit",
			now: start,
		});
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async (dueJob) => {
				prompts.push(dueJob.prompt);
			},
		});

		await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));

		expect(prompts).toEqual(["continue the audit"]);
		expect(store.list()[0]).toMatchObject({
			id: job.id,
			status: "completed",
			runCount: 1,
			lastRunAt: "2026-01-01T12:35:00.000Z",
		});
		expect(store.list()[0]).not.toHaveProperty("nextRunAt");
	});

	it("reschedules recurring jobs after each run", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "* * * * *",
			prompt: "poll status",
			now: new Date("2026-01-01T12:34:00.000Z"),
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async () => {},
		});

		await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));

		expect(store.list()[0]).toMatchObject({
			status: "active",
			runCount: 1,
			lastRunAt: "2026-01-01T12:35:00.000Z",
			nextRunAt: "2026-01-01T12:36:00.000Z",
		});
	});

	it("reschedules interval heartbeats after each run", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:34:30.000Z"),
			runJob: async () => {},
		});

		await scheduler.runDue(new Date("2026-01-01T12:34:30.000Z"));

		expect(store.list()[0]).toMatchObject({
			status: "active",
			runCount: 1,
			lastRunAt: "2026-01-01T12:34:30.000Z",
			nextRunAt: "2026-01-01T12:35:00.000Z",
		});
	});
});

describe("createAgentHeartbeatToolDefinitions", () => {
	it("lets the model create a heartbeat when explicitly requested", async () => {
		const tools = createAgentHeartbeatToolDefinitions({
			getHeartbeat: () => undefined,
			createHeartbeat: (instruction, interval) =>
				({
					id: "job-1",
					status: "active",
					source: "heartbeat",
					activeSessionId: "active-1",
					sessionId: "session-1",
					sessionFile: "/tmp/session.jsonl",
					cwd: "/tmp/project",
					prompt: instruction,
					schedule: { kind: "interval", expression: interval ?? "every 5m", intervalMs: 30_000 },
					createdAt: start.toISOString(),
					updatedAt: start.toISOString(),
					nextRunAt: "2026-01-01T12:34:30.000Z",
					runCount: 0,
				}) as const,
			updateHeartbeat: () => undefined,
		});
		const tool = tools.find((candidate) => candidate.name === "create_heartbeat");

		expect(tool).toBeDefined();

		const result = await tool!.execute(
			"tool-1",
			{ interval: "every 30s", instruction: "check on me" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details).toMatchObject({
			id: "job-1",
			schedule: { expression: "every 30s" },
			prompt: "check on me",
		});
	});

	it("lets the model inspect and update heartbeat state", async () => {
		const tools = createAgentHeartbeatToolDefinitions({
			getHeartbeat: () =>
				({
					id: "job-1",
					status: "active",
					source: "heartbeat",
					activeSessionId: "active-1",
					sessionId: "session-1",
					sessionFile: "/tmp/session.jsonl",
					cwd: "/tmp/project",
					prompt: "check on me",
					schedule: { kind: "interval", expression: "every 30s", intervalMs: 30_000 },
					createdAt: start.toISOString(),
					updatedAt: start.toISOString(),
					nextRunAt: "2026-01-01T12:34:30.000Z",
					runCount: 0,
				}) as const,
			createHeartbeat: () => {
				throw new Error("not used");
			},
			updateHeartbeat: (action) =>
				({
					id: "job-1",
					status: action === "pause" ? "paused" : "cancelled",
					source: "heartbeat",
					activeSessionId: "active-1",
					sessionId: "session-1",
					sessionFile: "/tmp/session.jsonl",
					cwd: "/tmp/project",
					prompt: "check on me",
					schedule: { kind: "interval", expression: "every 30s", intervalMs: 30_000 },
					createdAt: start.toISOString(),
					updatedAt: start.toISOString(),
					runCount: 0,
				}) as const,
		});

		const getResult = await tools
			.find((candidate) => candidate.name === "get_heartbeat")!
			.execute("tool-1", {}, undefined, undefined, {} as never);
		const updateResult = await tools
			.find((candidate) => candidate.name === "update_heartbeat")!
			.execute("tool-2", { action: "pause" }, undefined, undefined, {} as never);

		expect(getResult.details).toMatchObject({ id: "job-1", status: "active" });
		expect(updateResult.details).toMatchObject({ id: "job-1", status: "paused" });
	});
});

function makeStorePath(tempDirs: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-cron-"));
	tempDirs.push(dir);
	return join(dir, "cron-jobs.json");
}

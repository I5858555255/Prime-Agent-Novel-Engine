import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	OrchestratorReporter,
	type OrchestratorReporterConfig,
	readReporterConfigFromEnv,
} from "../src/modes/daemon/orchestrator-reporter.js";

const CONFIG: OrchestratorReporterConfig = {
	orchestratorUrl: "http://backend.test/api/v1/prime-agent",
	agentId: "agent-1",
	bootstrapToken: "pa-agent-1.secret",
	protocolVersion: "1",
	heartbeatIntervalMs: 30_000,
};

function fetchSpy() {
	return vi.fn(async () => new Response(null, { status: 200 }));
}

function callsTo(fetchMock: ReturnType<typeof fetchSpy>, path: string) {
	return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));
}

describe("readReporterConfigFromEnv", () => {
	it("returns null when bootstrap vars are absent", () => {
		expect(readReporterConfigFromEnv({})).toBeNull();
		expect(readReporterConfigFromEnv({ ORCHESTRATOR_URL: "http://x", PRIME_AGENT_ID: "a" })).toBeNull();
	});

	it("builds config and strips a trailing slash from the url", () => {
		const config = readReporterConfigFromEnv({
			ORCHESTRATOR_URL: "http://backend.test/api/v1/prime-agent/",
			PRIME_AGENT_ID: "agent-1",
			PRIME_AGENT_BOOTSTRAP_TOKEN: "tok",
			PRIME_AGENT_HEARTBEAT_SECONDS: "10",
		});
		expect(config).not.toBeNull();
		expect(config?.orchestratorUrl).toBe("http://backend.test/api/v1/prime-agent");
		expect(config?.heartbeatIntervalMs).toBe(10_000);
	});

	it("falls back to the default interval for bad values", () => {
		const config = readReporterConfigFromEnv({
			ORCHESTRATOR_URL: "http://x",
			PRIME_AGENT_ID: "a",
			PRIME_AGENT_BOOTSTRAP_TOKEN: "t",
			PRIME_AGENT_HEARTBEAT_SECONDS: "nonsense",
		});
		expect(config?.heartbeatIntervalMs).toBe(30_000);
	});
});

describe("OrchestratorReporter", () => {
	let fetchMock: ReturnType<typeof fetchSpy>;

	beforeEach(() => {
		fetchMock = fetchSpy();
	});

	it("heartbeats with the bootstrap token and posts the initial status", async () => {
		const reporter = new OrchestratorReporter(CONFIG, () => ({ status: "completed" }), { fetch: fetchMock });
		await reporter.tick();

		const heartbeats = callsTo(fetchMock, "/daemon/heartbeat");
		const statuses = callsTo(fetchMock, "/daemon/status");
		expect(heartbeats).toHaveLength(1);
		expect(statuses).toHaveLength(1);

		const [, init] = heartbeats[0];
		expect((init?.headers as Record<string, string>).authorization).toBe("Bearer pa-agent-1.secret");
		expect(JSON.parse(String((statuses[0][1] as RequestInit).body)).status).toBe("completed");
	});

	it("only re-posts status when the activity changes", async () => {
		let activity: "working" | "needs_input" | "completed" = "completed";
		const reporter = new OrchestratorReporter(CONFIG, () => ({ status: activity }), { fetch: fetchMock });

		await reporter.tick(); // completed (initial)
		await reporter.tick(); // unchanged -> no new status post
		activity = "working";
		await reporter.tick(); // changed -> posts

		expect(callsTo(fetchMock, "/daemon/heartbeat")).toHaveLength(3);
		const statuses = callsTo(fetchMock, "/daemon/status");
		expect(statuses).toHaveLength(2);
		expect(JSON.parse(String((statuses[1][1] as RequestInit).body)).status).toBe("working");
	});

	it("includes the root session id in status updates", async () => {
		const reporter = new OrchestratorReporter(CONFIG, () => ({ status: "working", rootAgentSessionId: "sess-1" }), {
			fetch: fetchMock,
		});
		await reporter.reportStatus({ status: "working", rootAgentSessionId: "sess-1" });

		const body = JSON.parse(String((callsTo(fetchMock, "/daemon/status")[0][1] as RequestInit).body));
		expect(body.root_agent_session_id).toBe("sess-1");
	});

	it("swallows fetch errors so reporting never breaks the daemon", async () => {
		const failing = vi.fn(async () => {
			throw new Error("network down");
		});
		const logs: string[] = [];
		const reporter = new OrchestratorReporter(CONFIG, () => ({ status: "completed" }), {
			fetch: failing,
			log: (message) => logs.push(message),
		});

		await expect(reporter.tick()).resolves.toBeUndefined();
		expect(logs.some((line) => line.includes("failed"))).toBe(true);
	});
});

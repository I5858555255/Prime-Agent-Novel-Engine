import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeScheduler } from "../../../src/core/agent-runtime-scheduler.js";
import type { HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { buildRlmBootstrapCode } from "../../../src/core/tools/ipython.js";
import { createHarness, type Harness } from "../harness.js";

interface InspectableSchedulerSession {
	_createKernelHostHandlers(): HostRequestHandlers;
}

const cleanupRoots: string[] = [];
const cleanupHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of cleanupHarnesses.splice(0).reverse()) harness.cleanup();
	for (const root of cleanupRoots.splice(0).reverse()) {
		rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(prefix: string): { root: string; repository: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	cleanupRoots.push(root);
	const repository = join(root, "repository");
	mkdirSync(repository);
	git(repository, ["init"]);
	git(repository, ["branch", "-M", "main"]);
	git(repository, ["config", "user.email", "test@example.com"]);
	git(repository, ["config", "user.name", "Test User"]);
	git(repository, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repository, "shared.txt"), "base\n");
	git(repository, ["add", "shared.txt"]);
	git(repository, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repository };
}

async function createConflictedChild(name: string): Promise<{
	parent: Harness;
	scheduler: AgentRuntimeScheduler;
	repository: string;
	childId: string;
	reconciledChildIds: string[];
}> {
	const { root, repository } = createRepository(`prime-agent-p7-${name}-`);
	const scheduler = new AgentRuntimeScheduler({
		workspacePath: repository,
		runId: `run-${name}`,
		statePath: join(root, "scheduler", "state.json"),
	});
	const child = await createHarness();
	cleanupHarnesses.push(child);
	let childWorkspace: string | undefined;
	const reconciledChildIds: string[] = [];
	const parent = await createHarness({
		cwd: repository,
		agentRuntimeScheduler: scheduler,
		subagentRuntimeHost: {
			createRlmSubagentRuntime: async (options) => {
				childWorkspace = options.cwd;
				return { session: child.session };
			},
			reconcileRlmSubagentRuntime: async (childId) => {
				reconciledChildIds.push(childId);
			},
			deleteRlmSubagentRuntime: async () => {},
		},
	});
	cleanupHarnesses.push(parent);
	child.setResponses([
		async () => {
			if (!childWorkspace) throw new Error("Expected an isolated child workspace");
			writeFileSync(join(childWorkspace, "shared.txt"), "child\n");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			return fauxAssistantMessage("Candidate completed.");
		},
	]);

	const handle = await parent.session.runRlmChild("Change the shared registration", { name });
	await expect.poll(() => childWorkspace, { timeout: 10_000 }).toEqual(expect.any(String));
	writeFileSync(join(repository, "shared.txt"), "parent\n");
	await expect.poll(() => parent.session.getRlmChildRunStatus(handle.rlm_child_id), { timeout: 10_000 }).toBe("error");
	return { parent, scheduler, repository, childId: handle.rlm_child_id, reconciledChildIds };
}

describe("issue 1056 agent runtime scheduler phase seven", () => {
	it("retries a retained promotion through the RLM host API and reconciles child success", async () => {
		const { parent, scheduler, repository, childId, reconciledChildIds } =
			await createConflictedChild("recoverable-child");
		writeFileSync(join(repository, "shared.txt"), "base\n");
		const handlers = (parent.session as unknown as InspectableSchedulerSession)._createKernelHostHandlers();

		await expect(handlers["rlm.retry_integration"]?.({ target: "recoverable-child" })).resolves.toMatchObject({
			outcome: "promoted",
			subagent: { rlm_child_id: childId, status: "completed" },
			integration: { taskId: childId, status: "integrated", promotionStatus: "promoted" },
		});

		expect(parent.session.getRlmChildRunStatus(childId)).toBe("done");
		expect((await parent.session.listRlmSubagents()).subagents).toContainEqual(
			expect.objectContaining({ rlm_child_id: childId, status: "completed" }),
		);
		expect(scheduler.getTask(childId)?.status).toBe("integrated");
		expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe("child\n");
		expect(reconciledChildIds).toEqual([childId]);
	});

	it("keeps a failed retry non-successful and exposes explicit abandonment", async () => {
		const { parent, scheduler, childId } = await createConflictedChild("abandoned-child");
		const handlers = (parent.session as unknown as InspectableSchedulerSession)._createKernelHostHandlers();

		await expect(handlers["rlm.retry_integration"]?.({ target: childId })).resolves.toMatchObject({
			outcome: "conflict",
			subagent: { status: "error" },
			integration: { status: "conflict", promotionStatus: "conflict" },
		});
		expect(parent.session.getRlmChildRunStatus(childId)).toBe("error");

		await expect(
			handlers["rlm.abandon_integration"]?.({ target: "abandoned-child", reason: "Parent chose another fix" }),
		).resolves.toMatchObject({
			outcome: "abandoned",
			subagent: { rlm_child_id: childId, status: "error" },
			integration: { status: "failed", promotionStatus: "failed", error: "Parent chose another fix" },
		});
		expect(scheduler.getTask(childId)?.status).toBe("cancelled");
	});

	it("validates retained-candidate control payloads and direct-child selectors", async () => {
		const harness = await createHarness();
		cleanupHarnesses.push(harness);
		const handlers = (harness.session as unknown as InspectableSchedulerSession)._createKernelHostHandlers();

		await expect(handlers["rlm.retry_integration"]?.({ target: "  " })).rejects.toThrow(
			"rlm.retry_integration target must be a non-empty string",
		);
		await expect(handlers["rlm.abandon_integration"]?.({ target: "child", reason: "  " })).rejects.toThrow(
			"rlm.abandon_integration reason must be a non-empty string when provided",
		);
		await expect(
			handlers["rlm.abandon_integration"]?.({ target: "child", reason: "x".repeat(1025) }),
		).rejects.toThrow("rlm.abandon_integration reason must be at most 1024 characters");
		await expect(handlers["rlm.retry_integration"]?.({ target: "unknown-child" })).rejects.toThrow(
			'No direct RLM subagent matches "unknown-child"',
		);
	});

	it("keeps retained-candidate controls explicit in the missing-runtime fallback", () => {
		const bootstrap = buildRlmBootstrapCode();
		expect(bootstrap).toContain("async def retry_integration(self, target)");
		expect(bootstrap).toContain("async def abandon_integration(self, target, reason=None)");
	});
});

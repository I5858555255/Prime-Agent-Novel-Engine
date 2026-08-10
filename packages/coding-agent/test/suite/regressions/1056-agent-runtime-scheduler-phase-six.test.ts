import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGitWorkspace } from "../../../src/core/agent-git-worktree.js";
import {
	type AgentRuntimeIntegrationRecord,
	AgentRuntimeScheduler,
} from "../../../src/core/agent-runtime-scheduler.js";
import { acquireAgentRuntimeWorkspaceScheduler } from "../../../src/core/agent-runtime-workspace-service.js";
import type { Harness } from "../harness.js";
import { createHarness } from "../harness.js";

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

async function createCandidate(
	scheduler: AgentRuntimeScheduler,
	repository: string,
	root: string,
	id: string,
	writeChanges: (workspacePath: string) => void,
): Promise<AgentGitWorkspace> {
	scheduler.registerTask({ id, objective: `Complete ${id}`, status: "queued" });
	scheduler.registerAgent({ id, taskId: id });
	scheduler.transitionTask(id, "preparing_workspace");
	const workspace = await scheduler.prepareAgentWorkspace(id, {
		sourceCwd: repository,
		metadataDir: join(root, "metadata", id),
	});
	if (!workspace) throw new Error("Expected Git worktree provisioning");
	scheduler.markAgentRunning(id);
	scheduler.transitionTask(id, "running");
	writeChanges(workspace.worktreePath);
	await scheduler.finalizeAgentWorkspace(id, `${id} finished`);
	scheduler.completeAgent(id);
	scheduler.transitionTask(id, "completed");
	return workspace;
}

function requireIntegration(record: AgentRuntimeIntegrationRecord | undefined): AgentRuntimeIntegrationRecord {
	if (!record) throw new Error("Expected integration record");
	return record;
}

describe("issue 1056 agent runtime scheduler phase six", () => {
	it("shares one workspace scheduler across independent roots and fences its lifetime", () => {
		const { root, repository } = createRepository("prime-agent-workspace-service-1056-");
		const nested = join(repository, "nested");
		mkdirSync(nested);
		const agentDir = join(root, "agent-data");
		const first = acquireAgentRuntimeWorkspaceScheduler({ workspacePath: repository, agentDir });
		const second = acquireAgentRuntimeWorkspaceScheduler({ workspacePath: nested, agentDir });
		try {
			expect(second.scheduler).toBe(first.scheduler);
			first.scheduler.registerTask({ id: "shared-task", objective: "Coordinate roots" });
			expect(second.scheduler.getTask("shared-task")?.objective).toBe("Coordinate roots");
			expect(first.scheduler.summary().workspaceAuthority).toMatchObject({ writable: true, epoch: 1 });
			expect(existsSync(first.statePath)).toBe(true);
			const helperPath = join(root, "cross-process-authority.ts");
			const serviceUrl = pathToFileURL(
				join(process.cwd(), "src", "core", "agent-runtime-workspace-service.ts"),
			).href;
			writeFileSync(
				helperPath,
				[
					`import { acquireAgentRuntimeWorkspaceScheduler } from ${JSON.stringify(serviceUrl)};`,
					`const handle = acquireAgentRuntimeWorkspaceScheduler({ workspacePath: ${JSON.stringify(repository)}, agentDir: ${JSON.stringify(agentDir)} });`,
					"let error;",
					"try { handle.scheduler.registerTask({ id: 'competing-task', objective: 'Must be fenced' }); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }",
					"console.log(JSON.stringify({ writable: handle.scheduler.isWorkspaceAuthorityOwner(), error }));",
					"handle.release();",
				].join("\n"),
			);
			const tsxCli = join(process.cwd(), "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
			const childResult = JSON.parse(execFileSync(process.execPath, [tsxCli, helperPath], { encoding: "utf8" })) as {
				writable: boolean;
				error?: string;
			};
			expect(childResult).toMatchObject({ writable: false, error: expect.stringContaining("authority is owned") });
		} finally {
			first.release();
			expect(second.scheduler.isWorkspaceAuthorityOwner()).toBe(true);
			second.release();
		}
		const replacement = acquireAgentRuntimeWorkspaceScheduler({ workspacePath: repository, agentDir });
		try {
			expect(replacement.scheduler.getTask("shared-task")?.objective).toBe("Coordinate roots");
			expect(replacement.scheduler.summary().workspaceAuthority).toMatchObject({ writable: true, epoch: 2 });
		} finally {
			replacement.release();
		}
	});

	it("promotes a child result without changing HEAD, the index, or unrelated dirty files", async () => {
		const { root, repository } = createRepository("prime-agent-promotion-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-promotion",
			statePath: join(root, "scheduler", "state.json"),
		});
		await createCandidate(scheduler, repository, root, "task-feature", (workspacePath) => {
			writeFileSync(join(workspacePath, "feature.txt"), "child feature\n");
		});
		writeFileSync(join(repository, "staged.txt"), "staged parent work\n");
		git(repository, ["add", "staged.txt"]);
		writeFileSync(join(repository, "unrelated.txt"), "unstaged parent work\n");
		const headBefore = git(repository, ["rev-parse", "HEAD"]);
		const indexBefore = git(repository, ["write-tree"]);

		const record = requireIntegration(
			await scheduler.integrateAgentWorkspace("task-feature", { promotionSourceCwd: repository }),
		);

		expect(record).toMatchObject({
			status: "integrated",
			promotionStatus: "promoted",
			promotionRecoverySha: expect.any(String),
		});
		expect(readFileSync(join(repository, "feature.txt"), "utf8")).toBe("child feature\n");
		expect(readFileSync(join(repository, "staged.txt"), "utf8")).toBe("staged parent work\n");
		expect(readFileSync(join(repository, "unrelated.txt"), "utf8")).toBe("unstaged parent work\n");
		expect(git(repository, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(git(repository, ["write-tree"])).toBe(indexBefore);
	});

	it("keeps a conflicting promotion non-successful and supports an explicit retry", async () => {
		const { root, repository } = createRepository("prime-agent-promotion-conflict-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-promotion-conflict",
			statePath: join(root, "scheduler", "state.json"),
		});
		await createCandidate(scheduler, repository, root, "task-conflict", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "child\n");
		});
		writeFileSync(join(repository, "shared.txt"), "parent\n");

		const conflict = requireIntegration(
			await scheduler.integrateAgentWorkspace("task-conflict", { promotionSourceCwd: repository }),
		);
		expect(conflict).toMatchObject({ status: "conflict", promotionStatus: "conflict" });
		expect(scheduler.getTask("task-conflict")?.status).toBe("conflict");
		expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe("parent\n");

		writeFileSync(join(repository, "shared.txt"), "base\n");
		const retried = await scheduler.retryIntegrationPromotion("task-conflict");
		expect(retried).toMatchObject({ status: "integrated", promotionStatus: "promoted" });
		expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe("child\n");
	});

	it("reruns quality gates against parent changes before final promotion", async () => {
		const { root, repository } = createRepository("prime-agent-final-gate-1056-");
		writeFileSync(join(repository, "api.txt"), "v1\n");
		writeFileSync(join(repository, "consumer.txt"), "v1\n");
		git(repository, ["add", "api.txt", "consumer.txt"]);
		git(repository, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "api baseline"]);
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-final-gate",
			statePath: join(root, "scheduler", "state.json"),
			integrationQualityGates: [
				{
					id: "api-compatibility",
					command: process.execPath,
					args: [
						"-e",
						"const fs=require('node:fs');if(fs.readFileSync('api.txt','utf8')!==fs.readFileSync('consumer.txt','utf8'))process.exit(8)",
					],
				},
			],
		});
		await createCandidate(scheduler, repository, root, "task-gated", (workspacePath) => {
			writeFileSync(join(workspacePath, "feature.txt"), "candidate\n");
		});
		writeFileSync(join(repository, "api.txt"), "v2\n");

		const record = requireIntegration(
			await scheduler.integrateAgentWorkspace("task-gated", { promotionSourceCwd: repository }),
		);
		expect(record).toMatchObject({
			status: "conflict",
			promotionStatus: "failed",
			gateResults: [expect.objectContaining({ id: "api-compatibility", passed: false, exitCode: 8 })],
		});
		expect(existsSync(join(repository, "feature.txt"))).toBe(false);
		expect(readFileSync(join(repository, "api.txt"), "utf8")).toBe("v2\n");
	});

	it("reports a child as failed when final promotion gates reject parent changes", async () => {
		const { root, repository } = createRepository("prime-agent-child-status-1056-");
		writeFileSync(join(repository, "api.txt"), "v1\n");
		writeFileSync(join(repository, "consumer.txt"), "v1\n");
		git(repository, ["add", "api.txt", "consumer.txt"]);
		git(repository, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "api baseline"]);
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-child-status",
			statePath: join(root, "scheduler", "state.json"),
			integrationQualityGates: [
				{
					id: "api-compatibility",
					command: process.execPath,
					args: [
						"-e",
						"const fs=require('node:fs');if(fs.readFileSync('api.txt','utf8')!==fs.readFileSync('consumer.txt','utf8'))process.exit(8)",
					],
				},
			],
		});
		const child = await createHarness();
		cleanupHarnesses.push(child);
		let childWorkspace: string | undefined;
		const parent = await createHarness({
			cwd: repository,
			agentRuntimeScheduler: scheduler,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					childWorkspace = options.cwd;
					return { session: child.session };
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		cleanupHarnesses.push(parent);
		child.setResponses([
			async () => {
				if (!childWorkspace) throw new Error("Expected an isolated child workspace");
				writeFileSync(join(childWorkspace, "feature.txt"), "candidate\n");
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
				return fauxAssistantMessage("Candidate completed.");
			},
		]);

		const handle = await parent.session.runRlmChild("Add a compatible feature", { name: "gated-child" });
		await expect.poll(() => childWorkspace, { timeout: 10_000 }).toEqual(expect.any(String));
		writeFileSync(join(repository, "api.txt"), "v2\n");
		await expect
			.poll(() => parent.session.getRlmChildRunStatus(handle.rlm_child_id), { timeout: 10_000 })
			.toBe("error");
		expect(scheduler.getTask(handle.rlm_child_id)?.status).toBe("conflict");
		expect(scheduler.getIntegrationRecord(handle.rlm_child_id)).toMatchObject({
			status: "conflict",
			promotionStatus: "failed",
		});
		expect(existsSync(join(repository, "feature.txt"))).toBe(false);
		expect(scheduler.abandonIntegration(handle.rlm_child_id, "User rejected the retained candidate")).toMatchObject({
			status: "failed",
			promotionStatus: "failed",
			error: "User rejected the retained candidate",
		});
		expect(scheduler.getTask(handle.rlm_child_id)?.status).toBe("cancelled");
	});

	it("renews a silent running child's resource lease from the host timer", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-host-heartbeat-1056-"));
		cleanupRoots.push(root);
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: root,
			runId: "run-host-heartbeat",
			statePath: join(root, "scheduler", "state.json"),
			resourceLeaseTtlMs: 200,
		});
		const child = await createHarness();
		cleanupHarnesses.push(child);
		let leaseStayedActive = false;
		const parent = await createHarness({
			agentRuntimeScheduler: scheduler,
			agentRuntimeHeartbeatIntervalMs: 10,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		cleanupHarnesses.push(parent);
		child.setResponses([
			async () => {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
				leaseStayedActive = scheduler.summary().activeResourceLeases.length === 1;
				return fauxAssistantMessage("Silent task completed.");
			},
		]);

		const handle = await parent.session.runRlmChild("Wait without tool activity", {
			name: "silent-worker",
			resources: ["service:silent"],
		});
		await expect.poll(() => scheduler.getTask(handle.rlm_child_id)?.status, { timeout: 10_000 }).toBe("integrated");
		expect(leaseStayedActive).toBe(true);
		expect(scheduler.snapshot().events.filter((event) => event.type === "resource_expired")).toEqual([]);
	});
});

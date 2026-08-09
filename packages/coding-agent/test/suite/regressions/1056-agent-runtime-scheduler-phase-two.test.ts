import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentGitWorktreeManager, parseAgentRuntimeResultManifest } from "../../../src/core/agent-git-worktree.js";
import { AgentRuntimeScheduler } from "../../../src/core/agent-runtime-scheduler.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

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
	return { root, repository };
}

function commitInitialFiles(repository: string): void {
	writeFileSync(join(repository, "tracked.txt"), "initial tracked\n");
	writeFileSync(join(repository, "staged.txt"), "initial staged\n");
	git(repository, ["add", "tracked.txt", "staged.txt"]);
	git(repository, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"]);
}

describe("issue 1056 agent runtime scheduler phase two", () => {
	it("captures dirty state without changing the parent index and keeps candidate results stable", async () => {
		const { root, repository } = createRepository("prime-agent-worktree-1056-");
		commitInitialFiles(repository);
		writeFileSync(join(repository, "tracked.txt"), "parent unstaged change\n");
		writeFileSync(join(repository, "staged.txt"), "parent staged change\n");
		writeFileSync(join(repository, "untracked.txt"), "parent untracked file\n");
		git(repository, ["add", "staged.txt"]);
		const parentHeadBefore = git(repository, ["rev-parse", "HEAD"]);
		const parentBranchBefore = git(repository, ["branch", "--show-current"]);
		const parentIndexBefore = git(repository, ["diff", "--cached", "--binary"]);

		const manager = new AgentGitWorktreeManager({
			runId: "run-phase-two",
			preferredRoot: join(root, "managed-worktrees"),
		});
		const workspace = await manager.provision({
			sourceCwd: repository,
			taskId: "task-dirty-base",
			agentId: "agent-dirty-base",
			objective: "Modify the isolated candidate",
			metadataDir: join(root, "metadata"),
		});
		expect(workspace).toBeDefined();
		if (!workspace) throw new Error("Expected Git worktree provisioning");

		expect(workspace.worktreePath).not.toBe(repository);
		expect(readFileSync(join(workspace.worktreePath, "tracked.txt"), "utf8")).toBe("parent unstaged change\n");
		expect(readFileSync(join(workspace.worktreePath, "staged.txt"), "utf8")).toBe("parent staged change\n");
		expect(readFileSync(join(workspace.worktreePath, "untracked.txt"), "utf8")).toBe("parent untracked file\n");
		expect(git(repository, ["rev-parse", "HEAD"])).toBe(parentHeadBefore);
		expect(git(repository, ["branch", "--show-current"])).toBe(parentBranchBefore);
		expect(git(repository, ["diff", "--cached", "--binary"])).toBe(parentIndexBefore);

		writeFileSync(join(workspace.worktreePath, "tracked.txt"), "child candidate change\n");
		writeFileSync(join(workspace.worktreePath, "child-only.txt"), "candidate artifact\n");
		const manifest = await manager.finalize({
			workspace,
			runId: "run-phase-two",
			taskId: "task-dirty-base",
			agentId: "agent-dirty-base",
			finalSummary: "Created an isolated candidate.",
		});

		expect(manifest.changedFiles).toEqual(["child-only.txt", "tracked.txt"]);
		expect(parseAgentRuntimeResultManifest(JSON.parse(readFileSync(workspace.resultManifestPath, "utf8")))).toEqual(
			manifest,
		);
		writeFileSync(join(repository, "tracked.txt"), "later parent change\n");
		expect(git(repository, ["show", `${manifest.resultSha}:tracked.txt`])).toBe("child candidate change");
		expect(git(repository, ["show", `${workspace.baseSha}:tracked.txt`])).toBe("parent unstaged change");

		await manager.cleanup(workspace);
		expect(existsSync(workspace.worktreePath)).toBe(false);
		expect(git(repository, ["rev-parse", workspace.branch])).toBe(manifest.resultSha);
	});

	it("runs admitted Git children from the assigned worktree and persists a validated manifest", async () => {
		const schedulerRoot = mkdtempSync(join(tmpdir(), "prime-agent-scheduler-1056-p2-"));
		cleanupRoots.push(schedulerRoot);
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: schedulerRoot,
			runId: "run-session-phase-two",
			statePath: join(schedulerRoot, "state", "scheduler.json"),
		});
		const child = await createHarness();
		cleanupHarnesses.push(child);
		let runtimeOptions: CreateRlmSubagentRuntimeOptions | undefined;
		const parent = await createHarness({
			agentRuntimeScheduler: scheduler,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					runtimeOptions = options;
					return { session: child.session };
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		cleanupHarnesses.push(parent);
		git(parent.tempDir, ["init"]);
		git(parent.tempDir, ["branch", "-M", "main"]);
		git(parent.tempDir, ["config", "user.email", "test@example.com"]);
		git(parent.tempDir, ["config", "user.name", "Test User"]);
		git(parent.tempDir, ["config", "core.autocrlf", "false"]);
		writeFileSync(join(parent.tempDir, "shared.txt"), "parent version\n");
		git(parent.tempDir, ["add", "shared.txt"]);
		git(parent.tempDir, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"]);

		child.setResponses([
			async () => {
				const assignedCwd = runtimeOptions?.cwd;
				if (!assignedCwd) throw new Error("Child runtime did not receive an isolated cwd");
				writeFileSync(join(assignedCwd, "shared.txt"), "child version\n");
				return fauxAssistantMessage("Updated shared.txt in the assigned worktree.");
			},
		]);

		const spawned = await parent.session.runRlmChild("Update shared.txt", { name: "isolated-writer" });
		await expect.poll(() => scheduler.getAgent(spawned.rlm_child_id)?.status, { timeout: 10_000 }).toBe("completed");
		const agent = scheduler.getAgent(spawned.rlm_child_id);
		expect(runtimeOptions?.cwd).toBe(agent?.worktreePath);
		expect(runtimeOptions?.cwd).not.toBe(parent.tempDir);
		expect(readFileSync(join(parent.tempDir, "shared.txt"), "utf8")).toBe("parent version\n");
		expect(agent).toMatchObject({
			baseSha: expect.any(String),
			candidateSha: expect.any(String),
			branch: expect.stringContaining("prime-agent/"),
			resultManifestPath: expect.any(String),
		});
		expect(scheduler.summary().workspaceAgents).toEqual([
			expect.objectContaining({ id: spawned.rlm_child_id, candidateSha: agent?.candidateSha }),
		]);
		const manifest = parseAgentRuntimeResultManifest(
			JSON.parse(readFileSync(agent!.resultManifestPath!, "utf8")) as unknown,
		);
		expect(manifest.changedFiles).toEqual(["shared.txt"]);
		expect(git(parent.tempDir, ["show", `${manifest.resultSha}:shared.txt`])).toBe("child version");
		expect(child.session.messages.map(getMessageText).join("\n")).toContain("[agent runtime task contract]");
		await expect(scheduler.cleanupAgentWorkspace(spawned.rlm_child_id)).rejects.toThrow(
			"while task status is completed",
		);

		const restoredScheduler = new AgentRuntimeScheduler({
			workspacePath: schedulerRoot,
			runId: "run-session-phase-two",
			statePath: join(schedulerRoot, "state", "scheduler.json"),
		});
		expect(restoredScheduler.summary().workspaceAgents).toEqual([
			expect.objectContaining({ id: spawned.rlm_child_id, candidateSha: manifest.resultSha }),
		]);
		restoredScheduler.transitionTask(spawned.rlm_child_id, "integrating");
		restoredScheduler.transitionTask(spawned.rlm_child_id, "integrated");
		await restoredScheduler.cleanupAgentWorkspace(spawned.rlm_child_id);
		expect(existsSync(agent!.worktreePath!)).toBe(false);
		expect(restoredScheduler.getAgent(spawned.rlm_child_id)?.worktreeCleanedAt).toEqual(expect.any(String));
	});

	it("reports unsupported non-Git workspaces without creating a worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-non-git-1056-"));
		cleanupRoots.push(root);
		const manager = new AgentGitWorktreeManager({ runId: "run-non-git", preferredRoot: join(root, "managed") });
		const capability = await manager.inspectRepository(root);
		expect(capability.supported).toBe(false);
		await expect(
			manager.provision({
				sourceCwd: root,
				taskId: "task-non-git",
				agentId: "agent-non-git",
				objective: "No Git repository",
				metadataDir: join(root, "metadata"),
			}),
		).resolves.toBeUndefined();
	});
});

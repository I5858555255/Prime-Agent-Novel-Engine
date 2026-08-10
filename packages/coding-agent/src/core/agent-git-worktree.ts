import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const AGENT_RUNTIME_TASK_CONTRACT_VERSION = 1;
export const AGENT_RUNTIME_RESULT_MANIFEST_VERSION = 1;

export interface AgentGitRepositoryCapability {
	supported: boolean;
	reason?: string;
	repositoryRoot?: string;
	repositoryId?: string;
	gitCommonDir?: string;
	headSha?: string;
	dirty?: boolean;
}

export interface AgentRuntimeTaskContract {
	version: typeof AGENT_RUNTIME_TASK_CONTRACT_VERSION;
	runId: string;
	taskId: string;
	agentId: string;
	objective: string;
	acceptanceCriteria: string[];
	expectedOutputs: string[];
	writeMode: "write";
	repositoryId: string;
	repositoryRoot: string;
	baseSha: string;
	branch: string;
	worktreePath: string;
	createdAt: string;
}

export interface AgentRuntimeResultManifest {
	version: typeof AGENT_RUNTIME_RESULT_MANIFEST_VERSION;
	runId: string;
	taskId: string;
	agentId: string;
	repositoryId: string;
	baseSha: string;
	resultSha: string;
	branch: string;
	worktreePath: string;
	changedFiles: string[];
	commandsExecuted: string[];
	testsExecuted: string[];
	acceptanceCriteriaResults: Array<{ criterion: string; passed: boolean; evidence?: string }>;
	assumptions: string[];
	knownLimitations: string[];
	discoveredDependencies: string[];
	requestedFollowUpTasks: string[];
	finalSummary: string;
	createdAt: string;
}

export interface AgentGitWorkspace {
	repositoryId: string;
	repositoryRoot: string;
	gitCommonDir: string;
	baseSha: string;
	branch: string;
	worktreePath: string;
	taskContractPath: string;
	resultManifestPath: string;
	taskContract?: AgentRuntimeTaskContract;
}

export interface CreateAgentGitWorktreeManagerOptions {
	runId: string;
	preferredRoot?: string;
	now?: () => number;
}

export interface ProvisionAgentGitWorkspaceInput {
	sourceCwd: string;
	taskId: string;
	agentId: string;
	objective: string;
	metadataDir: string;
	acceptanceCriteria?: string[];
	expectedOutputs?: string[];
}

export interface FinalizeAgentGitWorkspaceInput {
	workspace: AgentGitWorkspace;
	runId: string;
	taskId: string;
	agentId: string;
	finalSummary: string;
}

const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const candidate = error as Error & { stderr?: unknown; stdout?: unknown };
	const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
	const stdout = typeof candidate.stdout === "string" ? candidate.stdout.trim() : "";
	return stderr || stdout || error.message;
}

function runGit(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		execFile(
			"git",
			args,
			{
				cwd,
				encoding: "utf8",
				env: environment ? { ...process.env, ...environment } : process.env,
				maxBuffer: GIT_OUTPUT_LIMIT,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr).trim() || String(stdout).trim() || error.message;
					const failure = new Error(`git ${args.join(" ")} failed: ${detail}`);
					Object.assign(failure, { cause: error, stderr: String(stderr), stdout: String(stdout) });
					rejectPromise(failure);
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

function canonicalPath(path: string): string {
	const resolved = resolve(path);
	let canonical = resolved;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		canonical = resolved;
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isWithin(parentPath: string, candidatePath: string): boolean {
	const pathFromParent = relative(canonicalPath(parentPath), canonicalPath(candidatePath));
	return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function sanitizeIdentifier(value: string, fallback: string): string {
	const sanitized = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 48);
	return sanitized || fallback;
}

function repositoryIdFor(gitCommonDir: string): string {
	return createHash("sha256").update(canonicalPath(gitCommonDir)).digest("hex").slice(0, 16);
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, path);
}

function requiredString(record: Record<string, unknown>, key: string, kind = "Agent result manifest"): string {
	const value = record[key];
	if (typeof value !== "string" || !value) throw new Error(`${kind} has invalid ${key}`);
	return value;
}

function stringArray(record: Record<string, unknown>, key: string, kind = "Agent result manifest"): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${kind} has invalid ${key}`);
	}
	return [...value] as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentRuntimeTaskContract(value: unknown): AgentRuntimeTaskContract {
	if (!isRecord(value)) throw new Error("Agent task contract must be an object");
	if (value.version !== AGENT_RUNTIME_TASK_CONTRACT_VERSION || value.writeMode !== "write") {
		throw new Error("Agent task contract has invalid version or write mode");
	}
	const kind = "Agent task contract";
	return {
		version: AGENT_RUNTIME_TASK_CONTRACT_VERSION,
		runId: requiredString(value, "runId", kind),
		taskId: requiredString(value, "taskId", kind),
		agentId: requiredString(value, "agentId", kind),
		objective: requiredString(value, "objective", kind),
		acceptanceCriteria: stringArray(value, "acceptanceCriteria", kind),
		expectedOutputs: stringArray(value, "expectedOutputs", kind),
		writeMode: "write",
		repositoryId: requiredString(value, "repositoryId", kind),
		repositoryRoot: requiredString(value, "repositoryRoot", kind),
		baseSha: requiredString(value, "baseSha", kind),
		branch: requiredString(value, "branch", kind),
		worktreePath: requiredString(value, "worktreePath", kind),
		createdAt: requiredString(value, "createdAt", kind),
	};
}

export function parseAgentRuntimeResultManifest(value: unknown): AgentRuntimeResultManifest {
	if (!isRecord(value)) throw new Error("Agent result manifest must be an object");
	if (value.version !== AGENT_RUNTIME_RESULT_MANIFEST_VERSION) {
		throw new Error(`Unsupported agent result manifest version: ${String(value.version)}`);
	}
	const acceptanceCriteriaResults = value.acceptanceCriteriaResults;
	if (!Array.isArray(acceptanceCriteriaResults)) {
		throw new Error("Agent result manifest has invalid acceptanceCriteriaResults");
	}
	return {
		version: AGENT_RUNTIME_RESULT_MANIFEST_VERSION,
		runId: requiredString(value, "runId"),
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		repositoryId: requiredString(value, "repositoryId"),
		baseSha: requiredString(value, "baseSha"),
		resultSha: requiredString(value, "resultSha"),
		branch: requiredString(value, "branch"),
		worktreePath: requiredString(value, "worktreePath"),
		changedFiles: stringArray(value, "changedFiles"),
		commandsExecuted: stringArray(value, "commandsExecuted"),
		testsExecuted: stringArray(value, "testsExecuted"),
		acceptanceCriteriaResults: acceptanceCriteriaResults.map((entry) => {
			if (!isRecord(entry) || typeof entry.criterion !== "string" || typeof entry.passed !== "boolean") {
				throw new Error("Agent result manifest has invalid acceptance criterion result");
			}
			if (entry.evidence !== undefined && typeof entry.evidence !== "string") {
				throw new Error("Agent result manifest has invalid acceptance criterion evidence");
			}
			return {
				criterion: entry.criterion,
				passed: entry.passed,
				evidence: entry.evidence,
			};
		}),
		assumptions: stringArray(value, "assumptions"),
		knownLimitations: stringArray(value, "knownLimitations"),
		discoveredDependencies: stringArray(value, "discoveredDependencies"),
		requestedFollowUpTasks: stringArray(value, "requestedFollowUpTasks"),
		finalSummary: requiredString(value, "finalSummary"),
		createdAt: requiredString(value, "createdAt"),
	};
}

export function formatAgentRuntimeTaskPrompt(contract: AgentRuntimeTaskContract, prompt: string): string {
	return [
		"[agent runtime task contract]",
		`task_id: ${contract.taskId}`,
		`base_sha: ${contract.baseSha}`,
		`branch: ${contract.branch}`,
		`worktree: ${contract.worktreePath}`,
		"All relative repository writes must stay inside this assigned worktree.",
		"The host will create and validate the candidate commit after the task completes.",
		"",
		"[task from parent]",
		"",
		prompt,
	].join("\n");
}

export class AgentGitWorktreeManager {
	private readonly runId: string;
	private readonly preferredRoot?: string;
	private readonly now: () => number;

	constructor(options: CreateAgentGitWorktreeManagerOptions) {
		if (!options.runId.trim()) throw new Error("Agent Git worktree manager runId must not be empty");
		this.runId = options.runId;
		this.preferredRoot = options.preferredRoot;
		this.now = options.now ?? Date.now;
	}

	async inspectRepository(sourceCwd: string): Promise<AgentGitRepositoryCapability> {
		try {
			const inside = (await runGit(sourceCwd, ["rev-parse", "--is-inside-work-tree"])).trim();
			if (inside !== "true") return { supported: false, reason: "cwd is not inside a Git working tree" };
			const repositoryRoot = canonicalPath((await runGit(sourceCwd, ["rev-parse", "--show-toplevel"])).trim());
			const commonDirOutput = (
				await runGit(sourceCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
			).trim();
			const gitCommonDir = canonicalPath(commonDirOutput);
			const headSha = (await runGit(sourceCwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
			await runGit(sourceCwd, ["worktree", "list", "--porcelain"]);
			const dirty = (await runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).length > 0;
			return {
				supported: true,
				repositoryRoot,
				repositoryId: repositoryIdFor(gitCommonDir),
				gitCommonDir,
				headSha,
				dirty,
			};
		} catch (error) {
			return { supported: false, reason: errorText(error) };
		}
	}

	async provision(input: ProvisionAgentGitWorkspaceInput): Promise<AgentGitWorkspace | undefined> {
		const capability = await this.inspectRepository(input.sourceCwd);
		if (
			!capability.supported ||
			!capability.repositoryRoot ||
			!capability.repositoryId ||
			!capability.gitCommonDir ||
			!capability.headSha
		) {
			return undefined;
		}
		const baseSha = capability.dirty
			? await this.createDirtyBaseSnapshot(capability.repositoryRoot, capability.headSha, input.taskId)
			: capability.headSha;
		const runSegment = sanitizeIdentifier(this.runId, "run");
		const taskSegment = sanitizeIdentifier(input.taskId, "task");
		const branch = `prime-agent/${runSegment}/${taskSegment}`;
		await runGit(capability.repositoryRoot, ["check-ref-format", "--branch", branch]);
		const managerRoot = this.resolveManagerRoot(capability.repositoryRoot, capability.repositoryId);
		mkdirSync(managerRoot, { recursive: true });
		const worktreePath = join(
			managerRoot,
			`${taskSegment}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`,
		);
		if (existsSync(worktreePath)) {
			throw new Error(`Scheduler-owned worktree path already exists: ${worktreePath}`);
		}
		const taskContractPath = join(input.metadataDir, "agent-runtime-task.json");
		const resultManifestPath = join(input.metadataDir, "agent-runtime-result.json");
		const taskContract: AgentRuntimeTaskContract = {
			version: AGENT_RUNTIME_TASK_CONTRACT_VERSION,
			runId: this.runId,
			taskId: input.taskId,
			agentId: input.agentId,
			objective: input.objective,
			acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
			expectedOutputs: [...(input.expectedOutputs ?? [])],
			writeMode: "write",
			repositoryId: capability.repositoryId,
			repositoryRoot: capability.repositoryRoot,
			baseSha,
			branch,
			worktreePath,
			createdAt: new Date(this.now()).toISOString(),
		};
		writeJsonAtomically(taskContractPath, taskContract);
		await runGit(capability.repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
		return {
			repositoryId: capability.repositoryId,
			repositoryRoot: capability.repositoryRoot,
			gitCommonDir: capability.gitCommonDir,
			baseSha,
			branch,
			worktreePath,
			taskContractPath,
			resultManifestPath,
			taskContract,
		};
	}

	async finalize(input: FinalizeAgentGitWorkspaceInput): Promise<AgentRuntimeResultManifest> {
		const { workspace } = input;
		const checkedOutBranch = (await runGit(workspace.worktreePath, ["branch", "--show-current"])).trim();
		if (checkedOutBranch !== workspace.branch) {
			throw new Error(
				`Agent worktree branch changed from ${workspace.branch} to ${checkedOutBranch || "detached HEAD"}`,
			);
		}
		await runGit(workspace.worktreePath, ["add", "-A", "--", "."]);
		const status = await runGit(workspace.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
		if (status.length > 0) {
			await runGit(workspace.worktreePath, [
				"-c",
				"user.name=Prime Agent Scheduler",
				"-c",
				"user.email=scheduler@prime-agent.local",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--no-gpg-sign",
				"-m",
				`prime-agent result ${input.taskId}`,
			]);
		}
		const remainingChanges = await runGit(workspace.worktreePath, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (remainingChanges.length > 0) {
			throw new Error("Agent candidate commit left uncommitted worktree changes");
		}
		const resultSha = (await runGit(workspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		await runGit(workspace.worktreePath, ["merge-base", "--is-ancestor", workspace.baseSha, resultSha]);
		const changedOutput = await runGit(workspace.worktreePath, [
			"diff",
			"--name-only",
			"-z",
			workspace.baseSha,
			resultSha,
		]);
		const manifest: AgentRuntimeResultManifest = {
			version: AGENT_RUNTIME_RESULT_MANIFEST_VERSION,
			runId: input.runId,
			taskId: input.taskId,
			agentId: input.agentId,
			repositoryId: workspace.repositoryId,
			baseSha: workspace.baseSha,
			resultSha,
			branch: workspace.branch,
			worktreePath: workspace.worktreePath,
			changedFiles: changedOutput.split("\0").filter(Boolean).sort(),
			commandsExecuted: [],
			testsExecuted: [],
			acceptanceCriteriaResults: [],
			assumptions: [],
			knownLimitations: ["Phase 2 does not yet capture individual command and test executions."],
			discoveredDependencies: [],
			requestedFollowUpTasks: [],
			finalSummary: input.finalSummary.trim() || "Agent completed without a textual summary.",
			createdAt: new Date(this.now()).toISOString(),
		};
		writeJsonAtomically(workspace.resultManifestPath, manifest);
		const validated = parseAgentRuntimeResultManifest(
			JSON.parse(readFileSync(workspace.resultManifestPath, "utf8")) as unknown,
		);
		if (
			validated.runId !== input.runId ||
			validated.taskId !== input.taskId ||
			validated.agentId !== input.agentId ||
			validated.repositoryId !== workspace.repositoryId ||
			validated.baseSha !== workspace.baseSha ||
			validated.resultSha !== resultSha ||
			validated.branch !== workspace.branch ||
			canonicalPath(validated.worktreePath) !== canonicalPath(workspace.worktreePath)
		) {
			throw new Error("Agent result manifest does not match its scheduler workspace assignment");
		}
		return validated;
	}

	async cleanup(workspace: AgentGitWorkspace): Promise<void> {
		const managerRoot = this.resolveManagerRoot(workspace.repositoryRoot, workspace.repositoryId);
		if (
			!isWithin(managerRoot, workspace.worktreePath) ||
			canonicalPath(managerRoot) === canonicalPath(workspace.worktreePath)
		) {
			throw new Error(`Refusing to remove worktree outside the scheduler-owned root: ${workspace.worktreePath}`);
		}
		await runGit(workspace.repositoryRoot, ["worktree", "remove", "--", workspace.worktreePath]);
	}

	async rollbackProvision(workspace: AgentGitWorkspace): Promise<void> {
		await this.cleanup(workspace);
		await runGit(workspace.repositoryRoot, ["update-ref", "-d", `refs/heads/${workspace.branch}`, workspace.baseSha]);
	}

	private async createDirtyBaseSnapshot(repositoryRoot: string, headSha: string, taskId: string): Promise<string> {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "prime-agent-git-index-"));
		const indexPath = join(temporaryDirectory, "index");
		const environment = { GIT_INDEX_FILE: indexPath };
		try {
			await runGit(repositoryRoot, ["read-tree", headSha], environment);
			await runGit(repositoryRoot, ["add", "-A", "--", "."], environment);
			const treeSha = (await runGit(repositoryRoot, ["write-tree"], environment)).trim();
			return (
				await runGit(
					repositoryRoot,
					[
						"-c",
						"user.name=Prime Agent Scheduler",
						"-c",
						"user.email=scheduler@prime-agent.local",
						"commit-tree",
						treeSha,
						"-p",
						headSha,
						"-m",
						`prime-agent base snapshot ${taskId}`,
					],
					environment,
				)
			).trim();
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	}

	private resolveManagerRoot(repositoryRoot: string, repositoryId: string): string {
		if (this.preferredRoot && !isWithin(repositoryRoot, this.preferredRoot)) {
			return resolve(this.preferredRoot, repositoryId);
		}
		return join(tmpdir(), "prime-agent-worktrees", repositoryId, sanitizeIdentifier(this.runId, "run"));
	}
}

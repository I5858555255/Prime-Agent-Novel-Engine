import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type AgentGitWorkspace,
	AgentGitWorktreeManager,
	type AgentRuntimeResultManifest,
} from "./agent-git-worktree.js";
import {
	type AgentIntegrationGateResult,
	type AgentIntegrationQualityGate,
	type AgentIntegrationWorkspace,
	AgentMergeManager,
	type AgentMergeOutcome,
} from "./agent-merge-manager.js";

export const AGENT_RUNTIME_SCHEDULER_STATE_VERSION = 3;

export type AgentRuntimeTaskStatus =
	| "planned"
	| "queued"
	| "preparing_workspace"
	| "running"
	| "completed"
	| "integrating"
	| "integrated"
	| "conflict"
	| "failed"
	| "cancelled";

export type AgentRuntimeAgentStatus = "admitted" | "running" | "recovering" | "completed" | "failed" | "cancelled";

export interface AgentRuntimeTaskRecord {
	id: string;
	objective: string;
	dependencies: string[];
	status: AgentRuntimeTaskStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface AgentRuntimeAgentRecord {
	id: string;
	taskId: string;
	parentAgentId?: string;
	sessionId?: string;
	sessionName?: string;
	status: AgentRuntimeAgentStatus;
	createdAt: string;
	updatedAt: string;
	heartbeatAt?: string;
	error?: string;
	repositoryId?: string;
	repositoryRoot?: string;
	gitCommonDir?: string;
	baseSha?: string;
	branch?: string;
	worktreePath?: string;
	taskContractPath?: string;
	resultManifestPath?: string;
	candidateSha?: string;
	worktreeCleanedAt?: string;
}

export interface AgentRuntimeSchedulerSnapshot {
	version: typeof AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
	workspaceId: string;
	runId: string;
	createdAt: string;
	updatedAt: string;
	tasks: AgentRuntimeTaskRecord[];
	agents: AgentRuntimeAgentRecord[];
	integrationRecords: AgentRuntimeIntegrationRecord[];
	integrationWorkspaces: AgentIntegrationWorkspace[];
}

export type AgentRuntimeIntegrationStatus = "queued" | "integrating" | AgentMergeOutcome;

export interface AgentRuntimeIntegrationRecord {
	taskId: string;
	agentId: string;
	repositoryId: string;
	baseSha: string;
	candidateSha: string;
	status: AgentRuntimeIntegrationStatus;
	queuedAt: string;
	startedAt?: string;
	completedAt?: string;
	recoverySha?: string;
	resultSha?: string;
	attemptedSha?: string;
	changedFiles: string[];
	conflictFiles: string[];
	gateResults: AgentIntegrationGateResult[];
	error?: string;
}

export interface AgentRuntimeTaskReadiness {
	taskId: string;
	ready: boolean;
	blockedBy: string[];
}

export interface AgentRuntimeSchedulerSummary {
	workspaceId: string;
	runId: string;
	updatedAt: string;
	taskCounts: Partial<Record<AgentRuntimeTaskStatus, number>>;
	agentCounts: Partial<Record<AgentRuntimeAgentStatus, number>>;
	readyTaskIds: string[];
	blockedTaskIds: string[];
	activeAgents: AgentRuntimeAgentRecord[];
	workspaceAgents: AgentRuntimeAgentRecord[];
	integrationRecords: AgentRuntimeIntegrationRecord[];
	integrationWorkspaces: AgentIntegrationWorkspace[];
}

export interface CreateAgentRuntimeSchedulerOptions {
	workspacePath: string;
	runId: string;
	statePath?: string;
	now?: () => number;
	integrationQualityGates?: AgentIntegrationQualityGate[];
}

export interface RegisterAgentRuntimeTaskInput {
	id: string;
	objective: string;
	dependencies?: string[];
	status?: "planned" | "queued";
}

export interface RegisterAgentRuntimeAgentInput {
	id: string;
	taskId: string;
	parentAgentId?: string;
	sessionId?: string;
	sessionName?: string;
}

const TASK_STATUSES: readonly AgentRuntimeTaskStatus[] = [
	"planned",
	"queued",
	"preparing_workspace",
	"running",
	"completed",
	"integrating",
	"integrated",
	"conflict",
	"failed",
	"cancelled",
];

const AGENT_STATUSES: readonly AgentRuntimeAgentStatus[] = [
	"admitted",
	"running",
	"recovering",
	"completed",
	"failed",
	"cancelled",
];

const INTEGRATION_STATUSES: readonly AgentRuntimeIntegrationStatus[] = [
	"queued",
	"integrating",
	"integrated",
	"conflict",
	"failed",
];

const TASK_TRANSITIONS: Readonly<Record<AgentRuntimeTaskStatus, ReadonlySet<AgentRuntimeTaskStatus>>> = {
	planned: new Set(["queued", "failed", "cancelled"]),
	queued: new Set(["preparing_workspace", "running", "failed", "cancelled"]),
	preparing_workspace: new Set(["running", "failed", "cancelled"]),
	running: new Set(["completed", "failed", "cancelled"]),
	completed: new Set(["integrating", "failed", "cancelled"]),
	integrating: new Set(["integrated", "conflict", "failed", "cancelled"]),
	integrated: new Set(),
	conflict: new Set(["integrating", "failed", "cancelled"]),
	failed: new Set(),
	cancelled: new Set(),
};

const AGENT_TRANSITIONS: Readonly<Record<AgentRuntimeAgentStatus, ReadonlySet<AgentRuntimeAgentStatus>>> = {
	admitted: new Set(["running", "recovering", "failed", "cancelled"]),
	running: new Set(["recovering", "completed", "failed", "cancelled"]),
	recovering: new Set(["running", "completed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

const READY_TASK_STATUSES = new Set<AgentRuntimeTaskStatus>(["planned", "queued"]);
const ACTIVE_AGENT_STATUSES = new Set<AgentRuntimeAgentStatus>(["admitted", "running", "recovering"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return [...value] as string[];
}

function parseTaskStatus(value: unknown): AgentRuntimeTaskStatus {
	if (!TASK_STATUSES.includes(value as AgentRuntimeTaskStatus)) {
		throw new Error("Agent runtime scheduler state has invalid task status");
	}
	return value as AgentRuntimeTaskStatus;
}

function parseAgentStatus(value: unknown): AgentRuntimeAgentStatus {
	if (!AGENT_STATUSES.includes(value as AgentRuntimeAgentStatus)) {
		throw new Error("Agent runtime scheduler state has invalid agent status");
	}
	return value as AgentRuntimeAgentStatus;
}

function parseIntegrationStatus(value: unknown): AgentRuntimeIntegrationStatus {
	if (!INTEGRATION_STATUSES.includes(value as AgentRuntimeIntegrationStatus)) {
		throw new Error("Agent runtime scheduler state has invalid integration status");
	}
	return value as AgentRuntimeIntegrationStatus;
}

function parseTask(value: unknown): AgentRuntimeTaskRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid task record");
	return {
		id: requiredString(value, "id"),
		objective: requiredString(value, "objective"),
		dependencies: stringArray(value, "dependencies"),
		status: parseTaskStatus(value.status),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		error: optionalString(value, "error"),
	};
}

function parseAgent(value: unknown): AgentRuntimeAgentRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid agent record");
	return {
		id: requiredString(value, "id"),
		taskId: requiredString(value, "taskId"),
		parentAgentId: optionalString(value, "parentAgentId"),
		sessionId: optionalString(value, "sessionId"),
		sessionName: optionalString(value, "sessionName"),
		status: parseAgentStatus(value.status),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		heartbeatAt: optionalString(value, "heartbeatAt"),
		error: optionalString(value, "error"),
		repositoryId: optionalString(value, "repositoryId"),
		repositoryRoot: optionalString(value, "repositoryRoot"),
		gitCommonDir: optionalString(value, "gitCommonDir"),
		baseSha: optionalString(value, "baseSha"),
		branch: optionalString(value, "branch"),
		worktreePath: optionalString(value, "worktreePath"),
		taskContractPath: optionalString(value, "taskContractPath"),
		resultManifestPath: optionalString(value, "resultManifestPath"),
		candidateSha: optionalString(value, "candidateSha"),
		worktreeCleanedAt: optionalString(value, "worktreeCleanedAt"),
	};
}

function parseGateResult(value: unknown): AgentIntegrationGateResult {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid gate result");
	const args = stringArray(value, "args");
	if (typeof value.passed !== "boolean" || typeof value.durationMs !== "number") {
		throw new Error("Agent runtime scheduler state has invalid gate result fields");
	}
	if (value.exitCode !== null && typeof value.exitCode !== "number") {
		throw new Error("Agent runtime scheduler state has invalid gate exitCode");
	}
	return {
		id: requiredString(value, "id"),
		command: requiredString(value, "command"),
		args,
		passed: value.passed,
		exitCode: value.exitCode,
		stdout: typeof value.stdout === "string" ? value.stdout : "",
		stderr: typeof value.stderr === "string" ? value.stderr : "",
		durationMs: value.durationMs,
	};
}

function parseIntegrationRecord(value: unknown): AgentRuntimeIntegrationRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid integration record");
	if (!Array.isArray(value.gateResults)) {
		throw new Error("Agent runtime scheduler state has invalid integration gate results");
	}
	return {
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		repositoryId: requiredString(value, "repositoryId"),
		baseSha: requiredString(value, "baseSha"),
		candidateSha: requiredString(value, "candidateSha"),
		status: parseIntegrationStatus(value.status),
		queuedAt: requiredString(value, "queuedAt"),
		startedAt: optionalString(value, "startedAt"),
		completedAt: optionalString(value, "completedAt"),
		recoverySha: optionalString(value, "recoverySha"),
		resultSha: optionalString(value, "resultSha"),
		attemptedSha: optionalString(value, "attemptedSha"),
		changedFiles: stringArray(value, "changedFiles"),
		conflictFiles: stringArray(value, "conflictFiles"),
		gateResults: value.gateResults.map(parseGateResult),
		error: optionalString(value, "error"),
	};
}

function parseIntegrationWorkspace(value: unknown): AgentIntegrationWorkspace {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid integration workspace");
	return {
		repositoryId: requiredString(value, "repositoryId"),
		repositoryRoot: requiredString(value, "repositoryRoot"),
		branch: requiredString(value, "branch"),
		worktreePath: requiredString(value, "worktreePath"),
		headSha: requiredString(value, "headSha"),
	};
}

function parseSnapshot(value: unknown): AgentRuntimeSchedulerSnapshot {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state must be an object");
	if (value.version !== AGENT_RUNTIME_SCHEDULER_STATE_VERSION) {
		throw new Error(`Unsupported agent runtime scheduler state version: ${String(value.version)}`);
	}
	if (
		!Array.isArray(value.tasks) ||
		!Array.isArray(value.agents) ||
		!Array.isArray(value.integrationRecords) ||
		!Array.isArray(value.integrationWorkspaces)
	) {
		throw new Error("Agent runtime scheduler state has invalid registry arrays");
	}
	const snapshot: AgentRuntimeSchedulerSnapshot = {
		version: AGENT_RUNTIME_SCHEDULER_STATE_VERSION,
		workspaceId: requiredString(value, "workspaceId"),
		runId: requiredString(value, "runId"),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		tasks: value.tasks.map(parseTask),
		agents: value.agents.map(parseAgent),
		integrationRecords: value.integrationRecords.map(parseIntegrationRecord),
		integrationWorkspaces: value.integrationWorkspaces.map(parseIntegrationWorkspace),
	};
	assertUniqueIds(snapshot.tasks, "task");
	assertUniqueIds(snapshot.agents, "agent");
	assertUniqueIds(
		snapshot.integrationRecords.map((record) => ({ id: record.taskId })),
		"integration task",
	);
	assertUniqueIds(
		snapshot.integrationWorkspaces.map((workspace) => ({ id: workspace.repositoryId })),
		"integration repository",
	);
	return snapshot;
}

function assertUniqueIds(records: Array<{ id: string }>, kind: string): void {
	const ids = new Set<string>();
	for (const record of records) {
		if (ids.has(record.id)) throw new Error(`Duplicate ${kind} id in agent runtime scheduler state: ${record.id}`);
		ids.add(record.id);
	}
}

function canonicalWorkspaceId(workspacePath: string): string {
	const resolved = resolve(workspacePath);
	let canonical = resolved;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		canonical = resolved;
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function cloneTask(task: AgentRuntimeTaskRecord): AgentRuntimeTaskRecord {
	return { ...task, dependencies: [...task.dependencies] };
}

function cloneAgent(agent: AgentRuntimeAgentRecord): AgentRuntimeAgentRecord {
	return { ...agent };
}

function cloneIntegrationRecord(record: AgentRuntimeIntegrationRecord): AgentRuntimeIntegrationRecord {
	return {
		...record,
		changedFiles: [...record.changedFiles],
		conflictFiles: [...record.conflictFiles],
		gateResults: record.gateResults.map((gate) => ({ ...gate, args: [...gate.args] })),
	};
}

export class AgentRuntimeScheduler {
	private readonly statePath?: string;
	private readonly now: () => number;
	private readonly tasks = new Map<string, AgentRuntimeTaskRecord>();
	private readonly agents = new Map<string, AgentRuntimeAgentRecord>();
	private readonly integrationRecords = new Map<string, AgentRuntimeIntegrationRecord>();
	private readonly integrationWorkspaces = new Map<string, AgentIntegrationWorkspace>();
	private readonly worktreeManager: AgentGitWorktreeManager;
	private readonly mergeManager: AgentMergeManager;
	private readonly integrationQualityGates: AgentIntegrationQualityGate[];
	private readonly integrationOperations = new Map<string, Promise<AgentRuntimeIntegrationRecord>>();
	private integrationTail: Promise<void> = Promise.resolve();
	private state: AgentRuntimeSchedulerSnapshot;

	constructor(options: CreateAgentRuntimeSchedulerOptions) {
		if (!options.runId.trim()) throw new Error("Agent runtime scheduler runId must not be empty");
		this.statePath = options.statePath;
		this.now = options.now ?? Date.now;
		this.worktreeManager = new AgentGitWorktreeManager({
			runId: options.runId,
			preferredRoot: options.statePath ? resolve(dirname(options.statePath), "worktrees") : undefined,
			now: this.now,
		});
		const integrationRoot = options.statePath
			? resolve(dirname(options.statePath), "integration")
			: resolve(
					tmpdir(),
					"prime-agent-integrations",
					createHash("sha256")
						.update(`${canonicalWorkspaceId(options.workspacePath)}\0${options.runId}`)
						.digest("hex")
						.slice(0, 16),
				);
		this.mergeManager = new AgentMergeManager({ runId: options.runId, preferredRoot: integrationRoot });
		this.integrationQualityGates = (options.integrationQualityGates ?? []).map((gate) => ({
			...gate,
			args: gate.args ? [...gate.args] : undefined,
		}));
		const workspaceId = canonicalWorkspaceId(options.workspacePath);
		const loaded = this.loadState();
		if (loaded) {
			if (loaded.workspaceId !== workspaceId || loaded.runId !== options.runId) {
				throw new Error("Agent runtime scheduler state does not match the requested workspace and run");
			}
			this.state = loaded;
		} else {
			const timestamp = this.timestamp();
			this.state = {
				version: AGENT_RUNTIME_SCHEDULER_STATE_VERSION,
				workspaceId,
				runId: options.runId,
				createdAt: timestamp,
				updatedAt: timestamp,
				tasks: [],
				agents: [],
				integrationRecords: [],
				integrationWorkspaces: [],
			};
		}
		for (const task of this.state.tasks) this.tasks.set(task.id, task);
		for (const agent of this.state.agents) this.agents.set(agent.id, agent);
		for (const record of this.state.integrationRecords) this.integrationRecords.set(record.taskId, record);
		for (const workspace of this.state.integrationWorkspaces) {
			this.integrationWorkspaces.set(workspace.repositoryId, workspace);
		}
		const recoveredAgents = this.markInterruptedAgentsRecovering();
		const recoveredIntegrations = this.markInterruptedIntegrationsQueued();
		if (recoveredAgents || recoveredIntegrations) this.persist();
		else if (!loaded) this.persist();
	}

	get workspaceId(): string {
		return this.state.workspaceId;
	}

	get runId(): string {
		return this.state.runId;
	}

	registerTask(input: RegisterAgentRuntimeTaskInput): AgentRuntimeTaskRecord {
		const id = input.id.trim();
		const objective = input.objective.trim();
		if (!id) throw new Error("Agent runtime task id must not be empty");
		if (!objective) throw new Error("Agent runtime task objective must not be empty");
		if (this.tasks.has(id)) throw new Error(`Duplicate agent runtime task id: ${id}`);
		const dependencies = [...new Set(input.dependencies ?? [])];
		if (dependencies.includes(id)) throw new Error(`Agent runtime task ${id} cannot depend on itself`);
		for (const dependency of dependencies) {
			if (!this.tasks.has(dependency)) {
				throw new Error(`Agent runtime task ${id} depends on unknown task ${dependency}`);
			}
		}
		const timestamp = this.timestamp();
		const task: AgentRuntimeTaskRecord = {
			id,
			objective,
			dependencies,
			status: input.status ?? "planned",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.tasks.set(id, task);
		this.persist();
		return cloneTask(task);
	}

	transitionTask(taskId: string, status: AgentRuntimeTaskStatus, error?: string): AgentRuntimeTaskRecord {
		const task = this.requireTask(taskId);
		if (task.status === status) return cloneTask(task);
		if (!TASK_TRANSITIONS[task.status].has(status)) {
			throw new Error(`Illegal agent runtime task transition: ${task.status} -> ${status}`);
		}
		task.status = status;
		task.updatedAt = this.timestamp();
		task.error = error?.trim() || undefined;
		this.persist();
		return cloneTask(task);
	}

	registerAgent(input: RegisterAgentRuntimeAgentInput): AgentRuntimeAgentRecord {
		const id = input.id.trim();
		if (!id) throw new Error("Agent runtime agent id must not be empty");
		if (this.agents.has(id)) throw new Error(`Duplicate agent runtime agent id: ${id}`);
		this.requireTask(input.taskId);
		const timestamp = this.timestamp();
		const agent: AgentRuntimeAgentRecord = {
			id,
			taskId: input.taskId,
			parentAgentId: input.parentAgentId,
			sessionId: input.sessionId,
			sessionName: input.sessionName,
			status: "admitted",
			createdAt: timestamp,
			updatedAt: timestamp,
			heartbeatAt: timestamp,
		};
		this.agents.set(id, agent);
		this.persist();
		return cloneAgent(agent);
	}

	markAgentRunning(agentId: string, sessionId?: string): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		this.transitionAgent(agent, "running");
		if (sessionId) agent.sessionId = sessionId;
		agent.heartbeatAt = agent.updatedAt;
		this.persist();
		return cloneAgent(agent);
	}

	recordAgentHeartbeat(agentId: string): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		if (!ACTIVE_AGENT_STATUSES.has(agent.status)) {
			return cloneAgent(agent);
		}
		if (agent.status !== "running") this.transitionAgent(agent, "running");
		else agent.updatedAt = this.timestamp();
		agent.heartbeatAt = agent.updatedAt;
		this.persist();
		return cloneAgent(agent);
	}

	async prepareAgentWorkspace(
		agentId: string,
		input: { sourceCwd: string; metadataDir: string },
	): Promise<AgentGitWorkspace | undefined> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		const workspace = await this.worktreeManager.provision({
			sourceCwd: input.sourceCwd,
			taskId: task.id,
			agentId: agent.id,
			objective: task.objective,
			metadataDir: input.metadataDir,
		});
		if (!workspace) return undefined;
		agent.repositoryId = workspace.repositoryId;
		agent.repositoryRoot = workspace.repositoryRoot;
		agent.gitCommonDir = workspace.gitCommonDir;
		agent.baseSha = workspace.baseSha;
		agent.branch = workspace.branch;
		agent.worktreePath = workspace.worktreePath;
		agent.taskContractPath = workspace.taskContractPath;
		agent.resultManifestPath = workspace.resultManifestPath;
		agent.updatedAt = this.timestamp();
		try {
			this.persist();
		} catch (error) {
			await this.worktreeManager.rollbackProvision(workspace).catch(() => undefined);
			delete agent.repositoryId;
			delete agent.repositoryRoot;
			delete agent.gitCommonDir;
			delete agent.baseSha;
			delete agent.branch;
			delete agent.worktreePath;
			delete agent.taskContractPath;
			delete agent.resultManifestPath;
			throw error;
		}
		return workspace;
	}

	async finalizeAgentWorkspace(
		agentId: string,
		finalSummary: string,
	): Promise<AgentRuntimeResultManifest | undefined> {
		const agent = this.requireAgent(agentId);
		const workspace = this.workspaceForAgent(agent);
		if (!workspace) return undefined;
		const manifest = await this.worktreeManager.finalize({
			workspace,
			runId: this.runId,
			taskId: agent.taskId,
			agentId: agent.id,
			finalSummary,
		});
		agent.candidateSha = manifest.resultSha;
		agent.resultManifestPath = workspace.resultManifestPath;
		agent.updatedAt = this.timestamp();
		this.persist();
		return manifest;
	}

	async cleanupAgentWorkspace(agentId: string): Promise<void> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		if (task.status !== "integrated" && task.status !== "cancelled") {
			throw new Error(`Cannot clean worktree for task ${task.id} while task status is ${task.status}`);
		}
		const workspace = this.workspaceForAgent(agent);
		if (!workspace || agent.worktreeCleanedAt) return;
		await this.worktreeManager.cleanup(workspace);
		agent.worktreeCleanedAt = this.timestamp();
		agent.updatedAt = agent.worktreeCleanedAt;
		this.persist();
	}

	async integrateAgentWorkspace(agentId: string): Promise<AgentRuntimeIntegrationRecord | undefined> {
		const agent = this.requireAgent(agentId);
		const workspace = this.workspaceForAgent(agent);
		if (!workspace || !agent.candidateSha) return undefined;
		const existing = this.integrationRecords.get(agent.taskId);
		if (
			existing &&
			(existing.status === "integrated" || existing.status === "conflict" || existing.status === "failed")
		) {
			return cloneIntegrationRecord(existing);
		}
		const activeOperation = this.integrationOperations.get(agent.taskId);
		if (activeOperation) return cloneIntegrationRecord(await activeOperation);
		if (!existing) {
			const record: AgentRuntimeIntegrationRecord = {
				taskId: agent.taskId,
				agentId: agent.id,
				repositoryId: workspace.repositoryId,
				baseSha: workspace.baseSha,
				candidateSha: agent.candidateSha,
				status: "queued",
				queuedAt: this.timestamp(),
				changedFiles: [],
				conflictFiles: [],
				gateResults: [],
			};
			this.integrationRecords.set(record.taskId, record);
			this.persist();
		}
		const operation = this.integrationTail.then(() => this.performIntegration(agent.id));
		this.integrationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.integrationOperations.set(agent.taskId, operation);
		try {
			return cloneIntegrationRecord(await operation);
		} finally {
			this.integrationOperations.delete(agent.taskId);
		}
	}

	async resumePendingIntegrations(): Promise<AgentRuntimeIntegrationRecord[]> {
		const pending = [...this.integrationRecords.values()]
			.filter((record) => record.status === "queued" || record.status === "integrating")
			.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.taskId.localeCompare(b.taskId));
		const results: AgentRuntimeIntegrationRecord[] = [];
		for (const record of pending) {
			const result = await this.integrateAgentWorkspace(record.agentId);
			if (result) results.push(result);
		}
		return results;
	}

	completeAgent(agentId: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "completed");
	}

	failAgent(agentId: string, error: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "failed", error);
	}

	cancelAgent(agentId: string, reason?: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "cancelled", reason);
	}

	markStaleAgentsRecovering(staleAfterMs: number): string[] {
		if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
			throw new Error("staleAfterMs must be a non-negative finite number");
		}
		const cutoff = this.now() - staleAfterMs;
		const recovering: string[] = [];
		for (const agent of this.agents.values()) {
			if (agent.status !== "running") continue;
			const heartbeat = Date.parse(agent.heartbeatAt ?? agent.updatedAt);
			if (Number.isFinite(heartbeat) && heartbeat > cutoff) continue;
			this.transitionAgent(agent, "recovering");
			recovering.push(agent.id);
		}
		if (recovering.length > 0) this.persist();
		return recovering;
	}

	getTaskReadiness(taskId: string): AgentRuntimeTaskReadiness {
		const task = this.requireTask(taskId);
		const blockedBy = task.dependencies.filter((dependency) => this.requireTask(dependency).status !== "integrated");
		return {
			taskId,
			ready: READY_TASK_STATUSES.has(task.status) && blockedBy.length === 0,
			blockedBy,
		};
	}

	getTask(taskId: string): AgentRuntimeTaskRecord | undefined {
		const task = this.tasks.get(taskId);
		return task ? cloneTask(task) : undefined;
	}

	getAgent(agentId: string): AgentRuntimeAgentRecord | undefined {
		const agent = this.agents.get(agentId);
		return agent ? cloneAgent(agent) : undefined;
	}

	getIntegrationRecord(taskId: string): AgentRuntimeIntegrationRecord | undefined {
		const record = this.integrationRecords.get(taskId);
		return record ? cloneIntegrationRecord(record) : undefined;
	}

	private async performIntegration(agentId: string): Promise<AgentRuntimeIntegrationRecord> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		const workspace = this.workspaceForAgent(agent);
		const record = this.integrationRecords.get(agent.taskId);
		if (!workspace || !agent.candidateSha || !record) {
			throw new Error(`Agent ${agentId} has no integration candidate`);
		}

		record.status = "integrating";
		record.startedAt ??= this.timestamp();
		record.completedAt = undefined;
		record.error = undefined;
		record.changedFiles = [];
		record.conflictFiles = [];
		record.gateResults = [];
		if (task.status === "completed" || task.status === "conflict") {
			this.transitionTask(task.id, "integrating");
		} else if (task.status === "integrating") {
			this.persist();
		} else {
			throw new Error(`Agent runtime task ${task.id} is not ready for integration: ${task.status}`);
		}

		try {
			const result = await this.mergeManager.integrate({
				taskId: task.id,
				candidateSha: agent.candidateSha,
				candidateWorkspace: workspace,
				integrationWorkspace: this.integrationWorkspaces.get(workspace.repositoryId),
				recoverySha: record.recoverySha,
				qualityGates: this.integrationQualityGates,
				onPrepared: (integrationWorkspace, recoverySha) => {
					this.integrationWorkspaces.set(integrationWorkspace.repositoryId, { ...integrationWorkspace });
					record.recoverySha = recoverySha;
					this.persist();
				},
			});
			this.integrationWorkspaces.set(result.integrationWorkspace.repositoryId, { ...result.integrationWorkspace });
			record.status = result.outcome;
			record.completedAt = this.timestamp();
			record.recoverySha = result.recoverySha;
			record.resultSha = result.resultSha;
			record.attemptedSha = result.attemptedSha;
			record.changedFiles = [...result.changedFiles];
			record.conflictFiles = [...result.conflictFiles];
			record.gateResults = result.gateResults.map((gate) => ({ ...gate, args: [...gate.args] }));
			record.error = result.error;
			this.transitionTask(task.id, result.outcome, result.error);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.status = "failed";
			record.completedAt = this.timestamp();
			record.error = message;
			if (task.status === "integrating" || task.status === "completed" || task.status === "conflict") {
				this.transitionTask(task.id, "failed", message);
			} else {
				this.persist();
			}
		}
		return cloneIntegrationRecord(record);
	}

	summary(): AgentRuntimeSchedulerSummary {
		const taskCounts: Partial<Record<AgentRuntimeTaskStatus, number>> = {};
		const agentCounts: Partial<Record<AgentRuntimeAgentStatus, number>> = {};
		const readyTaskIds: string[] = [];
		const blockedTaskIds: string[] = [];
		for (const task of this.tasks.values()) {
			taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
			if (!READY_TASK_STATUSES.has(task.status)) continue;
			const readiness = this.getTaskReadiness(task.id);
			if (readiness.ready) readyTaskIds.push(task.id);
			else blockedTaskIds.push(task.id);
		}
		const activeAgents: AgentRuntimeAgentRecord[] = [];
		const workspaceAgents: AgentRuntimeAgentRecord[] = [];
		for (const agent of this.agents.values()) {
			agentCounts[agent.status] = (agentCounts[agent.status] ?? 0) + 1;
			if (ACTIVE_AGENT_STATUSES.has(agent.status)) activeAgents.push(cloneAgent(agent));
			if (agent.worktreePath) workspaceAgents.push(cloneAgent(agent));
		}
		return {
			workspaceId: this.state.workspaceId,
			runId: this.state.runId,
			updatedAt: this.state.updatedAt,
			taskCounts,
			agentCounts,
			readyTaskIds: readyTaskIds.sort(),
			blockedTaskIds: blockedTaskIds.sort(),
			activeAgents: activeAgents.sort((a, b) => a.id.localeCompare(b.id)),
			workspaceAgents: workspaceAgents.sort((a, b) => a.id.localeCompare(b.id)),
			integrationRecords: [...this.integrationRecords.values()]
				.map(cloneIntegrationRecord)
				.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.taskId.localeCompare(b.taskId)),
			integrationWorkspaces: [...this.integrationWorkspaces.values()]
				.map((workspace) => ({ ...workspace }))
				.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
		};
	}

	snapshot(): AgentRuntimeSchedulerSnapshot {
		return {
			...this.state,
			tasks: [...this.tasks.values()].map(cloneTask),
			agents: [...this.agents.values()].map(cloneAgent),
			integrationRecords: [...this.integrationRecords.values()].map(cloneIntegrationRecord),
			integrationWorkspaces: [...this.integrationWorkspaces.values()].map((workspace) => ({ ...workspace })),
		};
	}

	private finishAgent(
		agentId: string,
		status: "completed" | "failed" | "cancelled",
		error?: string,
	): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		if (agent.status === status) return cloneAgent(agent);
		this.transitionAgent(agent, status);
		agent.error = error?.trim() || undefined;
		this.persist();
		return cloneAgent(agent);
	}

	private transitionAgent(agent: AgentRuntimeAgentRecord, status: AgentRuntimeAgentStatus): void {
		if (agent.status === status) return;
		if (!AGENT_TRANSITIONS[agent.status].has(status)) {
			throw new Error(`Illegal agent runtime agent transition: ${agent.status} -> ${status}`);
		}
		agent.status = status;
		agent.updatedAt = this.timestamp();
	}

	private requireTask(taskId: string): AgentRuntimeTaskRecord {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`Unknown agent runtime task: ${taskId}`);
		return task;
	}

	private requireAgent(agentId: string): AgentRuntimeAgentRecord {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent runtime agent: ${agentId}`);
		return agent;
	}

	private workspaceForAgent(agent: AgentRuntimeAgentRecord): AgentGitWorkspace | undefined {
		if (
			!agent.repositoryId ||
			!agent.repositoryRoot ||
			!agent.gitCommonDir ||
			!agent.baseSha ||
			!agent.branch ||
			!agent.worktreePath ||
			!agent.taskContractPath ||
			!agent.resultManifestPath
		) {
			return undefined;
		}
		return {
			repositoryId: agent.repositoryId,
			repositoryRoot: agent.repositoryRoot,
			gitCommonDir: agent.gitCommonDir,
			baseSha: agent.baseSha,
			branch: agent.branch,
			worktreePath: agent.worktreePath,
			taskContractPath: agent.taskContractPath,
			resultManifestPath: agent.resultManifestPath,
		};
	}

	private markInterruptedAgentsRecovering(): boolean {
		let changed = false;
		for (const agent of this.agents.values()) {
			if (agent.status !== "admitted" && agent.status !== "running") continue;
			this.transitionAgent(agent, "recovering");
			changed = true;
		}
		return changed;
	}

	private markInterruptedIntegrationsQueued(): boolean {
		let changed = false;
		for (const record of this.integrationRecords.values()) {
			if (record.status !== "integrating") continue;
			record.status = "queued";
			record.completedAt = undefined;
			changed = true;
		}
		return changed;
	}

	private loadState(): AgentRuntimeSchedulerSnapshot | undefined {
		if (!this.statePath || !existsSync(this.statePath)) return undefined;
		return parseSnapshot(JSON.parse(readFileSync(this.statePath, "utf8")) as unknown);
	}

	private persist(): void {
		this.state.tasks = [...this.tasks.values()];
		this.state.agents = [...this.agents.values()];
		this.state.integrationRecords = [...this.integrationRecords.values()];
		this.state.integrationWorkspaces = [...this.integrationWorkspaces.values()];
		this.state.updatedAt = this.timestamp();
		if (!this.statePath) return;
		mkdirSync(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}
}

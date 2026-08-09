import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const AGENT_RUNTIME_SCHEDULER_STATE_VERSION = 1;

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
}

export interface AgentRuntimeSchedulerSnapshot {
	version: typeof AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
	workspaceId: string;
	runId: string;
	createdAt: string;
	updatedAt: string;
	tasks: AgentRuntimeTaskRecord[];
	agents: AgentRuntimeAgentRecord[];
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
}

export interface CreateAgentRuntimeSchedulerOptions {
	workspacePath: string;
	runId: string;
	statePath?: string;
	now?: () => number;
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
	};
}

function parseSnapshot(value: unknown): AgentRuntimeSchedulerSnapshot {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state must be an object");
	if (value.version !== AGENT_RUNTIME_SCHEDULER_STATE_VERSION) {
		throw new Error(`Unsupported agent runtime scheduler state version: ${String(value.version)}`);
	}
	if (!Array.isArray(value.tasks) || !Array.isArray(value.agents)) {
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
	};
	assertUniqueIds(snapshot.tasks, "task");
	assertUniqueIds(snapshot.agents, "agent");
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

export class AgentRuntimeScheduler {
	private readonly statePath?: string;
	private readonly now: () => number;
	private readonly tasks = new Map<string, AgentRuntimeTaskRecord>();
	private readonly agents = new Map<string, AgentRuntimeAgentRecord>();
	private state: AgentRuntimeSchedulerSnapshot;

	constructor(options: CreateAgentRuntimeSchedulerOptions) {
		if (!options.runId.trim()) throw new Error("Agent runtime scheduler runId must not be empty");
		this.statePath = options.statePath;
		this.now = options.now ?? Date.now;
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
			};
		}
		for (const task of this.state.tasks) this.tasks.set(task.id, task);
		for (const agent of this.state.agents) this.agents.set(agent.id, agent);
		if (this.markInterruptedAgentsRecovering()) this.persist();
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
		for (const agent of this.agents.values()) {
			agentCounts[agent.status] = (agentCounts[agent.status] ?? 0) + 1;
			if (ACTIVE_AGENT_STATUSES.has(agent.status)) activeAgents.push(cloneAgent(agent));
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
		};
	}

	snapshot(): AgentRuntimeSchedulerSnapshot {
		return {
			...this.state,
			tasks: [...this.tasks.values()].map(cloneTask),
			agents: [...this.agents.values()].map(cloneAgent),
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

	private markInterruptedAgentsRecovering(): boolean {
		let changed = false;
		for (const agent of this.agents.values()) {
			if (agent.status !== "admitted" && agent.status !== "running") continue;
			this.transitionAgent(agent, "recovering");
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

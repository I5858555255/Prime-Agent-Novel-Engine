/**
 * Reports daemon liveness and agent activity to the Prime Agent Swarm control
 * plane.
 *
 * Active only when the bootstrap environment variables are present — i.e. when
 * the daemon runs as a cloud agent inside a Prime Sandbox. For a local daemon
 * the env vars are absent and this is a no-op.
 *
 * Contract (backend `prime_agent` module):
 *   POST {ORCHESTRATOR_URL}/daemon/heartbeat   {protocol_version}
 *   POST {ORCHESTRATOR_URL}/daemon/status      {status, root_agent_session_id?, protocol_version?}
 * both authenticated with `Authorization: Bearer <PRIME_AGENT_BOOTSTRAP_TOKEN>`.
 */

export type AgentActivity = "working" | "needs_input" | "completed";

export interface OrchestratorActivitySnapshot {
	status: AgentActivity;
	rootAgentSessionId?: string;
}

export interface OrchestratorReporterConfig {
	orchestratorUrl: string;
	agentId: string;
	bootstrapToken: string;
	protocolVersion: string;
	heartbeatIntervalMs: number;
}

export interface OrchestratorReporterDeps {
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

const DEFAULT_HEARTBEAT_SECONDS = 30;
const PROTOCOL_VERSION = "1";

/**
 * Build reporter config from the environment, or null when the daemon is not
 * running as a cloud agent (bootstrap vars absent).
 */
export function readReporterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorReporterConfig | null {
	const orchestratorUrl = env.ORCHESTRATOR_URL?.replace(/\/+$/, "");
	const agentId = env.PRIME_AGENT_ID;
	const bootstrapToken = env.PRIME_AGENT_BOOTSTRAP_TOKEN;
	if (!orchestratorUrl || !agentId || !bootstrapToken) {
		return null;
	}

	const seconds = Number(env.PRIME_AGENT_HEARTBEAT_SECONDS ?? DEFAULT_HEARTBEAT_SECONDS);
	const heartbeatSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_HEARTBEAT_SECONDS;

	return {
		orchestratorUrl,
		agentId,
		bootstrapToken,
		protocolVersion: PROTOCOL_VERSION,
		heartbeatIntervalMs: heartbeatSeconds * 1000,
	};
}

export class OrchestratorReporter {
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastStatus: AgentActivity | undefined;
	private lastRootSessionId: string | undefined;

	constructor(
		private readonly config: OrchestratorReporterConfig,
		private readonly getSnapshot: () => OrchestratorActivitySnapshot,
		private readonly deps: OrchestratorReporterDeps = {},
	) {}

	/** Post an initial status + heartbeat, then heartbeat on an interval. */
	start(): void {
		if (this.timer) {
			return;
		}
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.config.heartbeatIntervalMs);
		// A heartbeat loop should not keep the process alive on its own.
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** One heartbeat plus a status report if the activity changed. */
	async tick(): Promise<void> {
		await this.heartbeat();
		await this.reportStatus(this.getSnapshot());
	}

	async heartbeat(): Promise<void> {
		await this.post("/daemon/heartbeat", { protocol_version: this.config.protocolVersion });
	}

	/** Post a status update only when it differs from the last reported one. */
	async reportStatus(snapshot: OrchestratorActivitySnapshot): Promise<void> {
		if (snapshot.status === this.lastStatus && snapshot.rootAgentSessionId === this.lastRootSessionId) {
			return;
		}
		this.lastStatus = snapshot.status;
		this.lastRootSessionId = snapshot.rootAgentSessionId;
		await this.post("/daemon/status", {
			status: snapshot.status,
			root_agent_session_id: snapshot.rootAgentSessionId,
			protocol_version: this.config.protocolVersion,
		});
	}

	private async post(path: string, body: unknown): Promise<void> {
		const doFetch = this.deps.fetch ?? fetch;
		try {
			const response = await doFetch(`${this.config.orchestratorUrl}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.config.bootstrapToken}`,
				},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				this.deps.log?.(`${path} -> ${response.status}`);
			}
		} catch (error) {
			// Never let a transient reporting error disrupt the daemon.
			this.deps.log?.(`${path} failed: ${(error as Error).message}`);
		}
	}
}

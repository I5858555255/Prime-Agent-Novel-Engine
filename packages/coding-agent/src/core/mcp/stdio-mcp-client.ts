import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 1_000;

export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;

export interface StdioMcpClientOptions {
	server: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	startupTimeoutMs?: number;
	callTimeoutMs?: number;
}

export interface StdioMcpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	[key: string]: unknown;
}

export class StdioMcpTransportError extends Error {
	readonly retryable = true;
	readonly requestNotSent: boolean = false;

	constructor(message: string) {
		super(message);
		this.name = "StdioMcpTransportError";
	}
}

/** A transport failure that is known to have happened before the request was sent. */
export class StdioMcpRequestNotSentError extends StdioMcpTransportError {
	readonly requestNotSent = true;

	constructor(message: string) {
		super(message);
		this.name = "StdioMcpRequestNotSentError";
	}
}

export class StdioMcpProtocolError extends Error {
	readonly retryable = false;

	constructor(message: string) {
		super(message);
		this.name = "StdioMcpProtocolError";
	}
}

export function isRetryableStdioMcpError(error: unknown): boolean {
	return error instanceof StdioMcpTransportError;
}

export function isStdioMcpRequestNotSentError(error: unknown): boolean {
	return error instanceof StdioMcpRequestNotSentError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof globalThis.setTimeout>;
}

/** A bounded, long-lived MCP JSON-RPC client for one configured stdio server. */
export class StdioMcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private startPromise?: Promise<void>;
	private initialized = false;
	private toolsSupported = false;
	private disposed = false;
	private tainted = false;
	private taintError?: StdioMcpTransportError;
	private stopping?: Promise<void>;
	private nextRequestId = 1;
	private inputBuffer = "";
	private readonly pending = new Map<number, PendingRequest>();

	constructor(private readonly options: StdioMcpClientOptions) {}

	async listTools(): Promise<StdioMcpTool[]> {
		await this.start();
		this.ensureToolsSupported();
		const result = await this.request("tools/list", {}, this.callTimeoutMs);
		if (!isRecord(result) || !Array.isArray(result.tools)) {
			throw new StdioMcpProtocolError(`MCP server ${this.options.server} returned invalid tools`);
		}
		return result.tools.filter((tool): tool is StdioMcpTool => isRecord(tool) && typeof tool.name === "string");
	}

	async callTool(tool: string, arguments_: Record<string, unknown>): Promise<unknown> {
		await this.start();
		this.ensureToolsSupported();
		return this.request("tools/call", { name: tool, arguments: arguments_ }, this.callTimeoutMs);
	}

	async health(): Promise<void> {
		await this.start();
		await this.request("ping", {}, this.callTimeoutMs);
	}

	async restart(): Promise<void> {
		if (this.disposed) {
			throw new StdioMcpTransportError(`MCP server ${this.options.server} is disposed`);
		}
		try {
			if (this.tainted) {
				await this.waitForTaintCleanup(true);
			} else {
				this.tainted = true;
				await this.stop();
			}
			this.tainted = false;
			this.taintError = undefined;
			await this.start();
		} catch (error) {
			this.tainted = true;
			this.taintError = this.toTransportError(error);
			throw error;
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const starting = this.startPromise;
		await this.stop();
		if (starting) {
			await starting.catch(() => undefined);
		}
	}

	disposeSync(): void {
		this.disposed = true;
		this.stopSync();
	}

	private get startupTimeoutMs(): number {
		return this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	}

	private get callTimeoutMs(): number {
		return this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
	}

	private async start(): Promise<void> {
		if (this.disposed) {
			throw new StdioMcpTransportError(`MCP server ${this.options.server} is disposed`);
		}
		if (this.tainted) await this.waitForTaintCleanup(false);
		if (this.initialized && this.child) return;
		if (!this.startPromise) {
			const start = this.startInternal();
			this.startPromise = start;
			start.then(
				() => {
					if (this.startPromise === start) this.startPromise = undefined;
				},
				() => {
					if (this.startPromise === start) this.startPromise = undefined;
				},
			);
		}
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Put the sidecar in its own group where supported so shutdown also
			// reaps descendants a server may have spawned.
			detached: process.platform !== "win32",
		});
		this.child = child;
		this.initialized = false;
		this.toolsSupported = false;
		this.inputBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		// Keep stderr private. MCP servers often print credentials or request payloads.
		child.stderr.on("data", () => undefined);
		child.on("error", (error) => this.handleChildFailure(child, error));
		child.stdin.on("error", (error) => this.handleChildFailure(child, error));
		child.on("exit", () => this.handleChildFailure(child, new Error("process exited")));

		try {
			const initializeResult = await this.request(
				"initialize",
				{
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "prime-agent", version: "0.7.1" },
				},
				this.startupTimeoutMs,
			);
			if (!isRecord(initializeResult) || typeof initializeResult.protocolVersion !== "string") {
				throw new StdioMcpProtocolError(`MCP server ${this.options.server} returned an invalid initialize result`);
			}
			if (
				!SUPPORTED_PROTOCOL_VERSIONS.includes(
					initializeResult.protocolVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
				)
			) {
				throw new StdioMcpProtocolError(
					`MCP server ${this.options.server} negotiated unsupported protocol version ${initializeResult.protocolVersion}; supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
				);
			}
			if (!isRecord(initializeResult.serverInfo)) {
				throw new StdioMcpProtocolError(`MCP server ${this.options.server} returned invalid serverInfo`);
			}
			if (!isRecord(initializeResult.capabilities)) {
				throw new StdioMcpProtocolError(`MCP server ${this.options.server} returned invalid capabilities`);
			}
			this.toolsSupported = isRecord(initializeResult.capabilities.tools);
			this.sendNotification("notifications/initialized", {});
			this.initialized = true;
			if (this.disposed)
				throw new StdioMcpTransportError(`MCP server ${this.options.server} was disposed during startup`);
		} catch (error) {
			await this.stop();
			if (error instanceof StdioMcpTransportError || error instanceof StdioMcpProtocolError) throw error;
			throw new StdioMcpTransportError(`MCP server ${this.options.server} failed to start`);
		}
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const child = this.child;
		if (!child || child.stdin.destroyed) {
			return Promise.reject(new StdioMcpRequestNotSentError(`MCP server ${this.options.server} is not running`));
		}
		const id = this.nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = globalThis.setTimeout(() => {
				this.pending.delete(id);
				this.taintAndStop();
				reject(new StdioMcpTransportError(`MCP server ${this.options.server} timed out during ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
			const rejectRequestNotSent = (error?: Error): void => {
				if (!this.pending.has(id)) return;
				globalThis.clearTimeout(timer);
				this.pending.delete(id);
				const detail = error?.message ? `: ${error.message}` : "";
				reject(new StdioMcpRequestNotSentError(`MCP server ${this.options.server} request failed${detail}`));
			};
			try {
				child.stdin.write(request, "utf8", (error?: Error | null) => {
					if (error) rejectRequestNotSent(error);
				});
			} catch (error) {
				rejectRequestNotSent(error instanceof Error ? error : undefined);
			}
		});
	}

	private sendNotification(method: string, params: Record<string, unknown>): void {
		const child = this.child;
		if (!child || child.stdin.destroyed) return;
		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error?: Error | null) => {
				if (error) this.handleChildFailure(child, error);
			});
		} catch (error) {
			this.handleChildFailure(child, error instanceof Error ? error : new Error("notification write failed"));
		}
	}

	private handleStdout(chunk: string): void {
		this.inputBuffer += chunk;
		while (true) {
			const newline = this.inputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.inputBuffer.slice(0, newline).trim();
			this.inputBuffer = this.inputBuffer.slice(newline + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				this.failPending(new StdioMcpProtocolError(`MCP server ${this.options.server} returned invalid JSON`));
				continue;
			}
			if (!isRecord(message)) continue;
			const id = message.id;
			if (typeof id !== "number") continue;
			const pending = this.pending.get(id);
			if (!pending) continue;
			this.pending.delete(id);
			globalThis.clearTimeout(pending.timer);
			const hasResult = Object.hasOwn(message, "result");
			const hasError = Object.hasOwn(message, "error");
			if (message.jsonrpc !== "2.0" || hasResult === hasError) {
				pending.reject(new StdioMcpProtocolError(`MCP server ${this.options.server} returned an invalid response`));
			} else if (hasError) {
				if (!isRecord(message.error)) {
					pending.reject(new StdioMcpProtocolError(`MCP server ${this.options.server} returned an invalid error`));
				} else {
					pending.reject(
						new StdioMcpProtocolError(
							`MCP server ${this.options.server} rejected ${String(message.error.code ?? "request")}`,
						),
					);
				}
			} else {
				pending.resolve(message.result);
			}
		}
	}

	private handleChildFailure(child: ChildProcessWithoutNullStreams, _error: Error): void {
		if (this.child !== child) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			this.child = undefined;
			this.initialized = false;
			this.toolsSupported = false;
			this.tainted = true;
			this.taintError = undefined;
			this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
			return;
		}
		this.taintAndStop();
	}

	private ensureToolsSupported(): void {
		if (!this.toolsSupported) {
			throw new StdioMcpProtocolError(
				`MCP server ${this.options.server} did not negotiate tool support (initialize capabilities.tools is missing)`,
			);
		}
	}

	private failPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			globalThis.clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private toTransportError(error: unknown): StdioMcpTransportError {
		if (error instanceof StdioMcpTransportError) return error;
		const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
		return new StdioMcpTransportError(`MCP server ${this.options.server} cleanup failed${detail}`);
	}

	private taintAndStop(): void {
		this.tainted = true;
		const stopping = this.stop();
		void stopping.then(
			() => undefined,
			(error) => {
				this.taintError = this.toTransportError(error);
			},
		);
	}

	private async waitForTaintCleanup(retryOnFailure: boolean): Promise<void> {
		const stopping = this.stopping;
		if (stopping) {
			try {
				await stopping;
			} catch (error) {
				if (!retryOnFailure) throw error;
				if (this.stopping === stopping) this.stopping = undefined;
				this.taintError = undefined;
				await this.stop();
			}
			if (this.stopping === stopping) this.stopping = undefined;
		}
		if (this.taintError) {
			if (!retryOnFailure) throw this.taintError;
			this.taintError = undefined;
			await this.stop();
		}
		this.tainted = false;
		this.taintError = undefined;
	}

	private stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		const stopping = Promise.resolve().then(() => this.stopInternal());
		this.stopping = stopping;
		stopping.then(
			() => {
				if (this.stopping === stopping) this.stopping = undefined;
			},
			() => {
				if (this.stopping === stopping) this.stopping = undefined;
			},
		);
		return stopping;
	}

	private async stopInternal(): Promise<void> {
		const child = this.child;
		this.initialized = false;
		this.toolsSupported = false;
		this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			if (this.child === child) this.child = undefined;
			return;
		}

		// MCP stdio shutdown starts with EOF on stdin. Signals are escalation only.
		try {
			if (!child.stdin.destroyed) child.stdin.end();
		} catch {
			// The child may have exited between the state check and end().
		}
		if (await this.waitForExit(child)) {
			if (this.child === child) this.child = undefined;
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			if (this.child === child) this.child = undefined;
			return;
		}

		this.killProcessTree(child, "SIGTERM");
		if (await this.waitForExit(child)) {
			if (this.child === child) this.child = undefined;
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			if (this.child === child) this.child = undefined;
			return;
		}

		this.killProcessTree(child, "SIGKILL");
		// Do not return until the child has actually emitted exit. This gives callers
		// a cleanup guarantee instead of merely confirming that a signal was sent.
		if (await this.waitForExit(child)) {
			if (this.child === child) this.child = undefined;
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			if (this.child === child) this.child = undefined;
			return;
		}

		// Keep the live child reference so a later dispose() can retry cleanup. Its
		// exit handler will clear the reference if the process exits asynchronously.
		if (this.child === undefined) this.child = child;
		throw new StdioMcpTransportError(`MCP server ${this.options.server} did not exit after SIGKILL`);
	}

	/** Synchronous SIGKILL-only cleanup for process-exit hooks; async waits are impossible. */
	private stopSync(): void {
		const child = this.child;
		this.child = undefined;
		this.initialized = false;
		this.toolsSupported = false;
		this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
		if (!child || child.exitCode !== null) return;
		this.killProcessTree(child, "SIGKILL");
	}

	private waitForExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof globalThis.setTimeout>;
			const onExit = (): void => {
				if (settled) return;
				settled = true;
				globalThis.clearTimeout(timer);
				resolve(true);
			};
			timer = globalThis.setTimeout(() => {
				if (settled) return;
				settled = true;
				child.off("exit", onExit);
				resolve(false);
			}, STOP_TIMEOUT_MS);
			timer.unref?.();
			child.once("exit", onExit);
		});
	}

	private killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && child.pid) {
				process.kill(-child.pid, signal);
			} else {
				child.kill(signal);
			}
		} catch {
			try {
				child.kill(signal);
			} catch {
				// Already exited.
			}
		}
	}
}

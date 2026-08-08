import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 1_000;

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

	constructor(message: string) {
		super(message);
		this.name = "StdioMcpTransportError";
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
	private disposed = false;
	private nextRequestId = 1;
	private inputBuffer = "";
	private readonly pending = new Map<number, PendingRequest>();

	constructor(private readonly options: StdioMcpClientOptions) {}

	async listTools(): Promise<StdioMcpTool[]> {
		await this.start();
		const result = await this.request("tools/list", {}, this.callTimeoutMs);
		if (!isRecord(result) || !Array.isArray(result.tools)) {
			throw new StdioMcpProtocolError(`MCP server ${this.options.server} returned invalid tools`);
		}
		return result.tools.filter((tool): tool is StdioMcpTool => isRecord(tool) && typeof tool.name === "string");
	}

	async callTool(tool: string, arguments_: Record<string, unknown>): Promise<unknown> {
		await this.start();
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
		await this.stop();
		await this.start();
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
		this.inputBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		// Keep stderr private. MCP servers often print credentials or request payloads.
		child.stderr.on("data", () => undefined);
		child.on("error", (error) => this.handleChildFailure(child, error));
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
			return Promise.reject(new StdioMcpTransportError(`MCP server ${this.options.server} is not running`));
		}
		const id = this.nextRequestId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = globalThis.setTimeout(() => {
				this.pending.delete(id);
				reject(new StdioMcpTransportError(`MCP server ${this.options.server} timed out during ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch {
				globalThis.clearTimeout(timer);
				this.pending.delete(id);
				reject(new StdioMcpTransportError(`MCP server ${this.options.server} request failed`));
			}
		});
	}

	private sendNotification(method: string, params: Record<string, unknown>): void {
		const child = this.child;
		if (!child || child.stdin.destroyed) return;
		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		} catch {
			// The next request will surface the transport failure.
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
		this.child = undefined;
		this.initialized = false;
		this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
	}

	private failPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			globalThis.clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	private async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.initialized = false;
		this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
		if (!child || child.exitCode !== null) return;
		this.killProcessTree(child, "SIGTERM");
		await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), sleep(STOP_TIMEOUT_MS)]);
		if (child.exitCode === null) this.killProcessTree(child, "SIGKILL");
	}

	private stopSync(): void {
		const child = this.child;
		this.child = undefined;
		this.initialized = false;
		this.failPending(new StdioMcpTransportError(`MCP server ${this.options.server} stopped`));
		if (!child || child.exitCode !== null) return;
		this.killProcessTree(child, "SIGKILL");
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

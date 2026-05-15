import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { ensureKernelPython } from "../kernel/bootstrap.js";
import type {
	RlmBackgroundRunHandler,
	RlmBackgroundRunStatusHandler,
	RlmBackgroundRunStatusResult,
	RlmBackgroundRunWaitHandler,
	RlmRunHandler,
	RlmRunResult,
} from "../rlm-runtime.js";
import type { PythonExecuteOptions, PythonExecuteResult, PythonExecutionBackend } from "./types.js";

const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const WORKER_READY_TIMEOUT_MS = 5000;
const RLM_DISPOSE_TIMEOUT_MS = 5000;

type JsonRpcId = number | string;

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcError;
}

interface PendingRequest<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export interface PrimeWorkerManagerOptions {
	/** Python interpreter that has `prime_agent_worker` and IPython available. Defaults to the auto-bootstrapped runtime. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	rlmRunHandler?: RlmRunHandler;
	rlmBackgroundRunHandler?: RlmBackgroundRunHandler;
	rlmBackgroundStatusHandler?: RlmBackgroundRunStatusHandler;
	rlmBackgroundWaitHandler?: RlmBackgroundRunWaitHandler;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "number" || typeof value === "string";
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && isJsonRpcId(value.id);
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
	return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && !("id" in value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	return isRecord(value) && value.jsonrpc === "2.0" && isJsonRpcId(value.id) && !("method" in value);
}

function isStreamName(value: unknown): value is "stdout" | "stderr" {
	return value === "stdout" || value === "stderr";
}

function parseString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function parseNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	return value;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return parseString(value, name);
}

function parseOptionalNumber(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	return parseNumber(value, name);
}

function parseStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${name} must be a string array`);
	}
	return value;
}

function parseErrorPayload(value: unknown): PythonExecuteResult["error"] {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("error must be an object");
	return {
		ename: parseString(value.ename, "error.ename"),
		evalue: parseString(value.evalue, "error.evalue"),
		traceback: parseStringArray(value.traceback, "error.traceback"),
	};
}

function parseExecuteResult(value: unknown): PythonExecuteResult {
	if (!isRecord(value)) throw new Error("worker execute result must be an object");
	const status = value.status;
	if (status !== "ok" && status !== "error" && status !== "aborted") {
		throw new Error("worker execute result status must be ok, error, or aborted");
	}
	return {
		stdout: parseString(value.stdout, "stdout"),
		stderr: parseString(value.stderr, "stderr"),
		result: parseOptionalString(value.result, "result"),
		status,
		error: parseErrorPayload(value.error),
		durationMs: parseNumber(value.durationMs, "durationMs"),
	};
}

function parseRecord(value: unknown, name: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${name} must be an object`);
	return value;
}

function parseRlmRunRequest(value: unknown): { prompt: string; kwargs: Record<string, unknown> } {
	if (!isRecord(value)) throw new Error("rlm request params must be an object");
	return {
		prompt: parseString(value.prompt, "prompt"),
		kwargs: parseRecord(value.kwargs, "kwargs"),
	};
}

function parseRlmStatusRequest(value: unknown): { id: string } {
	if (!isRecord(value)) throw new Error("rlm status params must be an object");
	return { id: parseString(value.id, "id") };
}

function parseRlmWaitRequest(value: unknown): { id: string; timeoutMs?: number } {
	if (!isRecord(value)) throw new Error("rlm wait params must be an object");
	return { id: parseString(value.id, "id"), timeoutMs: parseOptionalNumber(value.timeoutMs, "timeoutMs") };
}

function parseOutputNotification(value: unknown): { executeId: JsonRpcId; stream: "stdout" | "stderr"; text: string } {
	if (!isRecord(value)) throw new Error("output params must be an object");
	if (!isJsonRpcId(value.execute_id)) throw new Error("output execute_id must be a JSON-RPC id");
	if (!isStreamName(value.stream)) throw new Error("output stream must be stdout or stderr");
	return { executeId: value.execute_id, stream: value.stream, text: parseString(value.text, "text") };
}

function formatWorkerError(error: JsonRpcError): Error {
	if (error.data === undefined) return new Error(error.message);
	return new Error(`${error.message}: ${JSON.stringify(error.data)}`);
}

const liveWorkers = new Set<PrimeWorkerManager>();

registerSessionResourceCleanup((sessionId) => {
	for (const worker of liveWorkers) {
		if (!sessionId || worker.ownerSessionId === sessionId) {
			void worker.dispose();
		}
	}
});

export class PrimeWorkerManager implements PythonExecutionBackend {
	private readonly options: PrimeWorkerManagerOptions;
	private worker?: ChildProcess;
	private lines?: ReadlineInterface;
	private workerStderr = "";
	private nextRequestId = 1;
	private readonly pending = new Map<string, PendingRequest<unknown>>();
	private readonly activeOutputHandlers = new Map<string, (chunk: string, name: "stdout" | "stderr") => void>();
	private readonly inFlightRlmRuns = new Set<Promise<unknown>>();
	private executionQueue: Promise<unknown> = Promise.resolve();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;

	constructor(options: PrimeWorkerManagerOptions) {
		this.options = {
			python: options.python,
			cwd: options.cwd,
			env: options.env,
			sessionId: options.sessionId,
			rlmRunHandler: options.rlmRunHandler,
			rlmBackgroundRunHandler: options.rlmBackgroundRunHandler,
			rlmBackgroundStatusHandler: options.rlmBackgroundStatusHandler,
			rlmBackgroundWaitHandler: options.rlmBackgroundWaitHandler,
		};
	}

	get ownerSessionId(): string | undefined {
		return this.options.sessionId;
	}

	get isRunning(): boolean {
		return this.state === "running" && this.worker !== undefined && this.worker.exitCode === null;
	}

	async start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart();
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		if (this.state === "running") return;
		if (this.state !== "idle") return;

		this.state = "starting";
		this.workerStderr = "";

		let python: string;
		try {
			python = this.options.python ?? (await ensureKernelPython());
			this.options.python = python;
		} catch (error) {
			this.state = "idle";
			this.startPromise = undefined;
			throw error;
		}

		const worker = spawn(python, ["-m", "prime_agent_worker"], {
			cwd: this.options.cwd,
			env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.worker = worker;
		liveWorkers.add(this);

		worker.stderr?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			this.workerStderr += text;
			process.stderr.write(`[prime-worker] ${text}`);
		});

		worker.on("error", (error) => {
			if (this.worker !== worker) return;
			console.error(`[prime-worker] spawn error: ${error.message}`);
			this.cleanupWorker(new Error(`Python worker spawn error: ${error.message}`), "idle");
		});

		worker.on("exit", (code, signal) => {
			if (this.worker !== worker) return;
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			const tail = this.workerStderr.slice(-2048);
			this.cleanupWorker(new Error(`Python worker exited with ${reason}. stderr:\n${tail || "(empty)"}`), "idle");
		});

		if (!worker.stdout || !worker.stdin) {
			this.cleanupWorker(new Error("Python worker did not expose stdio pipes"), "idle");
			throw new Error("Python worker did not expose stdio pipes");
		}

		this.lines = createInterface({ input: worker.stdout });
		this.lines.on("line", (line) => {
			this.handleLine(line);
		});

		this.state = "running";

		try {
			await this.withTimeout(
				this.request("ping", {}),
				WORKER_READY_TIMEOUT_MS,
				"Python worker did not become ready",
			);
		} catch (error) {
			const message = errorMessage(error);
			this.cleanupWorker(new Error(message), "idle");
			throw error;
		}
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});
		return Promise.race([promise, timeoutPromise]).finally(() => {
			if (timeout) globalThis.clearTimeout(timeout);
		});
	}

	private nextId(): JsonRpcId {
		const id = this.nextRequestId;
		this.nextRequestId += 1;
		return id;
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		const id = this.nextId();
		return this.requestWithId<T>(id, method, params);
	}

	private requestWithId<T>(id: JsonRpcId, method: string, params: unknown): Promise<T> {
		const worker = this.worker;
		if (!worker?.stdin || worker.stdin.destroyed) {
			return Promise.reject(new Error("Python worker is not running"));
		}

		const key = String(id);
		let rejectRequest: (error: Error) => void = () => {};
		const promise = new Promise<T>((resolve, reject) => {
			rejectRequest = reject;
			this.pending.set(key, {
				resolve: (value) => resolve(value as T),
				reject,
			});
		});

		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const line = `${JSON.stringify(message)}\n`;
		worker.stdin.write(line, (error) => {
			if (!error) return;
			this.pending.delete(key);
			rejectRequest(error);
		});

		return promise;
	}

	private sendResponse(id: JsonRpcId, result: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", id, result }).catch((error) => {
			console.error(`[prime-worker] failed to write response: ${error.message}`);
		});
	}

	private sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", id, error: { code, message, data } }).catch((error) => {
			console.error(`[prime-worker] failed to write error response: ${error.message}`);
		});
	}

	private writeMessage(message: JsonRpcResponse): Promise<void> {
		const worker = this.worker;
		if (!worker?.stdin || worker.stdin.destroyed) {
			return Promise.reject(new Error("Python worker is not running"));
		}
		const line = `${JSON.stringify(message)}\n`;
		return new Promise((resolve, reject) => {
			worker.stdin!.write(line, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;

		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			console.error(`[prime-worker] invalid JSON from worker: ${line}`);
			return;
		}

		if (isJsonRpcResponse(message)) {
			this.handleResponse(message);
			return;
		}

		if (isJsonRpcRequest(message)) {
			void this.handleWorkerRequest(message);
			return;
		}

		if (isJsonRpcNotification(message)) {
			this.handleNotification(message);
			return;
		}

		console.error(`[prime-worker] unexpected message from worker: ${line}`);
	}

	private handleResponse(message: JsonRpcResponse): void {
		const pending = this.pending.get(String(message.id));
		if (!pending) return;
		this.pending.delete(String(message.id));

		if (message.error) {
			pending.reject(formatWorkerError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	private handleNotification(message: JsonRpcNotification): void {
		if (message.method !== "output") return;
		try {
			const output = parseOutputNotification(message.params);
			this.activeOutputHandlers.get(String(output.executeId))?.(output.text, output.stream);
		} catch (error) {
			console.error(`[prime-worker] bad output notification: ${errorMessage(error)}`);
		}
	}

	private async handleWorkerRequest(message: JsonRpcRequest): Promise<void> {
		try {
			const result = await this.dispatchWorkerRequest(message.method, message.params);
			this.sendResponse(message.id, result);
		} catch (error) {
			this.sendErrorResponse(message.id, -32000, errorMessage(error));
		}
	}

	private async dispatchWorkerRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "rlm.run":
				return this.trackRlmRun(this.handleRlmRun(params));
			case "rlm.background":
				return this.trackRlmRun(this.handleRlmBackgroundRun(params));
			case "rlm.background_status":
				return this.trackRlmRun(this.handleRlmBackgroundStatus(params));
			case "rlm.background_wait":
				return this.trackRlmRun(this.handleRlmBackgroundWait(params));
			default:
				throw new Error(`unknown worker request method: ${method}`);
		}
	}

	private async trackRlmRun<T>(promise: Promise<T>): Promise<T> {
		this.inFlightRlmRuns.add(promise);
		try {
			return await promise;
		} finally {
			this.inFlightRlmRuns.delete(promise);
		}
	}

	private async handleRlmRun(params: unknown): Promise<RlmRunResult> {
		if (!this.options.rlmRunHandler) throw new Error("rlm.run handler is not configured");
		return this.options.rlmRunHandler(parseRlmRunRequest(params));
	}

	private async handleRlmBackgroundRun(params: unknown): Promise<unknown> {
		if (!this.options.rlmBackgroundRunHandler) throw new Error("rlm.background handler is not configured");
		return this.options.rlmBackgroundRunHandler(parseRlmRunRequest(params));
	}

	private async handleRlmBackgroundStatus(params: unknown): Promise<RlmBackgroundRunStatusResult> {
		if (!this.options.rlmBackgroundStatusHandler) throw new Error("rlm.background_status handler is not configured");
		return this.options.rlmBackgroundStatusHandler(parseRlmStatusRequest(params));
	}

	private async handleRlmBackgroundWait(params: unknown): Promise<RlmBackgroundRunStatusResult> {
		if (!this.options.rlmBackgroundWaitHandler) throw new Error("rlm.background_wait handler is not configured");
		return this.options.rlmBackgroundWaitHandler(parseRlmWaitRequest(params));
	}

	async execute(code: string, options: PythonExecuteOptions = {}): Promise<PythonExecuteResult> {
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			resolveNext = resolve;
		});
		await prev;

		try {
			await this.start();
			if (options.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}

			const executeId = this.nextId();
			if (options.onStream) this.activeOutputHandlers.set(String(executeId), options.onStream);

			const startedAt = Date.now();
			let abortListener: (() => void) | undefined;
			let aborted = false;
			const requestPromise = this.requestWithId<unknown>(executeId, "execute", {
				code,
				execute_id: executeId,
				max_output_chars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
			});

			const abortPromise = new Promise<PythonExecuteResult>((resolve) => {
				abortListener = () => {
					aborted = true;
					requestPromise.catch(() => undefined);
					this.cleanupWorker(new Error("Python worker execution aborted"), "idle");
					resolve({ stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - startedAt });
				};
				options.signal?.addEventListener("abort", abortListener, { once: true });
			});

			try {
				const raw = await Promise.race([requestPromise.then(parseExecuteResult), abortPromise]);
				return raw;
			} finally {
				if (abortListener) options.signal?.removeEventListener("abort", abortListener);
				if (!aborted) requestPromise.catch(() => undefined);
				this.activeOutputHandlers.delete(String(executeId));
			}
		} finally {
			resolveNext();
		}
	}

	async restart(): Promise<void> {
		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			resolveNext = resolve;
		});
		await prev;

		try {
			this.cleanupWorker(new Error("Python worker restarted"), "idle");
			this.workerStderr = "";
			await this.start();
		} finally {
			resolveNext();
		}
	}

	async dispose(): Promise<void> {
		this.state = "shutdown";
		liveWorkers.delete(this);
		const inFlight = [...this.inFlightRlmRuns];
		if (inFlight.length > 0) {
			await this.waitForRlmRunsToSettle(inFlight, RLM_DISPOSE_TIMEOUT_MS);
		}
		this.cleanupWorker(new Error("Python worker disposed"), "shutdown");
	}

	private async waitForRlmRunsToSettle(tasks: Promise<unknown>[], timeoutMs: number): Promise<void> {
		let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
		const timeoutPromise = new Promise<"timeout">((resolve) => {
			timeout = globalThis.setTimeout(() => resolve("timeout"), timeoutMs);
			if (timeout && typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});

		const result = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeoutPromise]);
		if (timeout) globalThis.clearTimeout(timeout);
		if (result === "timeout") {
			console.error(
				`[prime-worker] timed out waiting ${timeoutMs}ms for ${tasks.length} rlm request(s) during dispose`,
			);
		}
	}

	private cleanupWorker(reason: Error, nextState: "idle" | "shutdown"): void {
		for (const pending of this.pending.values()) {
			pending.reject(reason);
		}
		this.pending.clear();
		this.activeOutputHandlers.clear();

		this.lines?.removeAllListeners();
		this.lines?.close();
		this.lines = undefined;

		const worker = this.worker;
		this.worker = undefined;
		if (worker && worker.exitCode === null && !worker.killed) {
			worker.removeAllListeners("exit");
			worker.removeAllListeners("error");
			worker.kill();
		}

		this.startPromise = undefined;
		this.state = nextState;
		if (nextState === "shutdown") liveWorkers.delete(this);
	}
}

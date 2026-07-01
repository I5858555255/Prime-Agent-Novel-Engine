import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BackgroundTaskKind = "bash" | "ipython" | "rlm";
export type BackgroundTaskStatus = "running" | "done" | "error" | "cancelled";
export type BackgroundTaskEventType = "start" | "update" | "end";

const DEFAULT_PREVIEW_MAX_CHARS = 12_000;
const UPDATE_THROTTLE_MS = 1000;

export interface BackgroundTaskSnapshot {
	id: string;
	kind: BackgroundTaskKind;
	title: string;
	input: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	endedAt?: number;
	backgroundedAt?: number;
	logPath: string;
	outputPreview: string;
	outputBytes: number;
	exitCode?: number | null;
	errorMessage?: string;
}

export interface BackgroundTaskEvent {
	type: BackgroundTaskEventType;
	task: BackgroundTaskSnapshot;
}

export interface BackgroundTaskManagerOptions {
	logDir?: string;
	onEvent?: (event: BackgroundTaskEvent) => void;
}

export interface CreateBackgroundTaskOptions {
	kind: BackgroundTaskKind;
	title: string;
	input: string;
	cancel?: () => void;
}

export interface BackgroundCompletionOptions {
	exitCode?: number | null;
	errorMessage?: string;
}

interface ActiveBackgroundableTask {
	handle: BackgroundTaskHandle;
	requestBackground: () => boolean;
}

function safeFileSegment(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 32) || "task";
}

function makeLogPath(logDir: string, kind: BackgroundTaskKind, id: string): string {
	return join(logDir, `${safeFileSegment(kind)}-${id}.log`);
}

function tailAppend(current: string, next: string, maxChars: number): string {
	const combined = current + next;
	if (combined.length <= maxChars) {
		return combined;
	}
	return combined.slice(combined.length - maxChars);
}

function formatTimestamp(value: number): string {
	return new Date(value).toISOString();
}

export function formatBackgroundTaskReference(task: BackgroundTaskSnapshot): string {
	return [
		`Background ${task.kind} task ${task.id} started.`,
		`Status: ${task.status}`,
		`Log: ${task.logPath}`,
		`Started: ${formatTimestamp(task.startedAt)}`,
		`Use /background to list tasks, /background read ${task.id} to read output, or /background cancel ${task.id} to stop it.`,
	].join("\n");
}

export class BackgroundTaskHandle {
	private readonly stream: WriteStream | undefined;
	private readonly cancelFn: (() => void) | undefined;
	private preview = "";
	private bytes = 0;
	private backgroundedAt: number | undefined;
	private endedAt: number | undefined;
	private status: BackgroundTaskStatus = "running";
	private exitCode: number | null | undefined;
	private errorMessage: string | undefined;
	private closed = false;
	private updateTimer: NodeJS.Timeout | undefined;
	private updateDirty = false;

	constructor(
		private readonly manager: BackgroundTaskManager,
		readonly id: string,
		readonly kind: BackgroundTaskKind,
		readonly title: string,
		readonly input: string,
		readonly logPath: string,
		cancel: (() => void) | undefined,
	) {
		this.cancelFn = cancel;
		this.stream = createWriteStream(logPath, { flags: "a" });
		this.writeHeader();
	}

	get isBackgrounded(): boolean {
		return this.backgroundedAt !== undefined;
	}

	get isFinished(): boolean {
		return this.status !== "running";
	}

	releaseStream(): void {
		this.closed = true;
		this.stream?.end();
	}

	append(text: string): void {
		if (!text) {
			return;
		}
		this.bytes += Buffer.byteLength(text, "utf-8");
		this.preview = tailAppend(this.preview, text, DEFAULT_PREVIEW_MAX_CHARS);
		if (!this.closed) {
			this.stream?.write(text);
		}
		this.scheduleUpdate();
	}

	appendBuffer(buffer: Buffer): void {
		if (buffer.length === 0) {
			return;
		}
		this.append(buffer.toString("utf-8"));
	}

	markBackgrounded(): BackgroundTaskSnapshot {
		if (this.backgroundedAt === undefined) {
			this.backgroundedAt = Date.now();
			this.manager.notify({ type: "start", task: this.snapshot() });
		}
		return this.snapshot();
	}

	complete(options: BackgroundCompletionOptions = {}): void {
		if (this.status !== "running") {
			return;
		}
		this.status = "done";
		this.exitCode = options.exitCode;
		this.finish(options.errorMessage);
	}

	fail(errorMessage: string, options: BackgroundCompletionOptions = {}): void {
		if (this.status !== "running") {
			return;
		}
		this.status = "error";
		this.errorMessage = errorMessage;
		this.exitCode = options.exitCode;
		this.finish(errorMessage);
	}

	cancel(reason = "Cancelled"): void {
		if (this.status !== "running") {
			return;
		}
		this.status = "cancelled";
		this.errorMessage = reason;
		try {
			this.cancelFn?.();
		} finally {
			this.finish(reason);
		}
	}

	discardIfForeground(): void {
		if (this.isBackgrounded) {
			return;
		}
		this.closeStream();
		try {
			rmSync(this.logPath, { force: true });
		} catch {}
		this.manager.deleteTask(this.id);
	}

	snapshot(): BackgroundTaskSnapshot {
		return {
			id: this.id,
			kind: this.kind,
			title: this.title,
			input: this.input,
			status: this.status,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			backgroundedAt: this.backgroundedAt,
			logPath: this.logPath,
			outputPreview: this.preview,
			outputBytes: this.bytes,
			exitCode: this.exitCode,
			errorMessage: this.errorMessage,
		};
	}

	readonly startedAt = Date.now();

	private writeHeader(): void {
		const header = [
			`# Prime Agent background ${this.kind} task`,
			`id: ${this.id}`,
			`started: ${formatTimestamp(this.startedAt)}`,
			`title: ${this.title}`,
			"",
			"## Input",
			this.input,
			"",
			"## Output",
			"",
		].join("\n");
		this.stream?.write(header);
	}

	private finish(message: string | undefined): void {
		this.endedAt = Date.now();
		if (message) {
			this.append(`\n[${this.status}: ${message}]\n`);
		}
		this.closeStream();
		if (this.isBackgrounded) {
			this.manager.notify({ type: "end", task: this.snapshot() });
		}
	}

	private closeStream(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
			this.updateTimer = undefined;
		}
		this.stream?.end();
	}

	private scheduleUpdate(): void {
		if (!this.isBackgrounded || this.status !== "running") {
			return;
		}
		this.updateDirty = true;
		if (this.updateTimer) {
			return;
		}
		this.updateTimer = setTimeout(() => {
			this.updateTimer = undefined;
			if (!this.updateDirty || this.status !== "running") {
				return;
			}
			this.updateDirty = false;
			this.manager.notify({ type: "update", task: this.snapshot() });
		}, UPDATE_THROTTLE_MS);
		this.updateTimer.unref?.();
	}
}

export class BackgroundTaskManager {
	private readonly logDir: string;
	private readonly onEvent: ((event: BackgroundTaskEvent) => void) | undefined;
	private readonly tasks = new Map<string, BackgroundTaskHandle>();
	private readonly active = new Map<string, ActiveBackgroundableTask>();

	constructor(options: BackgroundTaskManagerOptions = {}) {
		this.logDir = options.logDir ?? join(tmpdir(), `prime-agent-background-${randomUUID()}`);
		this.onEvent = options.onEvent;
		mkdirSync(this.logDir, { recursive: true });
	}

	createTask(options: CreateBackgroundTaskOptions): BackgroundTaskHandle {
		const id = `bg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const handle = new BackgroundTaskHandle(
			this,
			id,
			options.kind,
			options.title,
			options.input,
			makeLogPath(this.logDir, options.kind, id),
			options.cancel,
		);
		this.tasks.set(id, handle);
		return handle;
	}

	registerActive(handle: BackgroundTaskHandle, requestBackground: () => boolean): () => void {
		this.active.set(handle.id, { handle, requestBackground });
		return () => {
			this.active.delete(handle.id);
		};
	}

	requestBackgroundActive(): BackgroundTaskSnapshot | undefined {
		const entries = [...this.active.values()].reverse();
		for (const entry of entries) {
			if (entry.handle.isFinished || entry.handle.isBackgrounded) {
				continue;
			}
			if (entry.requestBackground()) {
				return entry.handle.snapshot();
			}
		}
		return undefined;
	}

	list(): BackgroundTaskSnapshot[] {
		return [...this.tasks.values()]
			.filter((task) => task.isBackgrounded)
			.map((task) => task.snapshot())
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	get(id: string): BackgroundTaskSnapshot | undefined {
		const task = this.tasks.get(id);
		if (!task?.isBackgrounded) {
			return undefined;
		}
		return task.snapshot();
	}

	read(id: string, maxBytes = 64_000): { task: BackgroundTaskSnapshot; output: string } | undefined {
		const task = this.tasks.get(id);
		if (!task?.isBackgrounded) {
			return undefined;
		}
		const snapshot = task.snapshot();
		try {
			if (!existsSync(snapshot.logPath)) {
				return { task: snapshot, output: "" };
			}
			const data = readFileSync(snapshot.logPath);
			const tail = data.length > maxBytes ? data.subarray(data.length - maxBytes) : data;
			const prefix = data.length > maxBytes ? `[showing last ${maxBytes} bytes of ${data.length}]\n` : "";
			return { task: snapshot, output: prefix + tail.toString("utf-8") };
		} catch (error) {
			return {
				task: snapshot,
				output: `Failed to read log: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	cancel(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task?.isBackgrounded || task.isFinished) {
			return false;
		}
		task.cancel("Cancelled by user");
		return true;
	}

	cancelAll(reason = "Session disposed"): void {
		for (const task of this.tasks.values()) {
			if (!task.isFinished) {
				task.cancel(reason);
			}
		}
	}

	notify(event: BackgroundTaskEvent): void {
		this.onEvent?.(event);
	}

	deleteTask(id: string): void {
		this.active.delete(id);
		this.tasks.delete(id);
	}
}

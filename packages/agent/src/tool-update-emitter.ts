import type { AgentEventSink } from "./agent-loop.js";
import type { AgentEvent } from "./types.js";

export const MAX_PENDING_TOOL_UPDATES = 32;

/** Serializes tool update emission so at most one sink call is in flight and no settled promise is retained. */
export class ToolUpdateEmitter {
	private readonly emit: AgentEventSink;
	private readonly maxPending: number;
	private readonly queue: AgentEvent[] = [];
	private tail: Promise<void> = Promise.resolve();
	private pumping = false;
	private closed = false;
	private abandoned = false;
	private failed = false;
	private failure: unknown;
	private dropped = 0;

	constructor(emit: AgentEventSink, maxPending: number = MAX_PENDING_TOOL_UPDATES) {
		if (!Number.isInteger(maxPending) || maxPending < 1) {
			throw new Error(`maxPending must be a positive integer, got ${maxPending}`);
		}
		this.emit = emit;
		this.maxPending = maxPending;
	}

	get droppedUpdates(): number {
		return this.dropped;
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	push(event: AgentEvent): void {
		if (this.closed || this.abandoned || this.failed) {
			return;
		}
		this.queue.push(event);
		if (this.queue.length > this.maxPending) {
			this.queue.shift();
			this.dropped += 1;
		}
		if (!this.pumping) {
			this.pumping = true;
			this.tail = this.pump();
		}
	}

	close(): void {
		this.closed = true;
	}

	abandon(): void {
		this.closed = true;
		this.abandoned = true;
		this.queue.length = 0;
	}

	async drain(): Promise<void> {
		// Re-read `this.tail` on every iteration: a `push()` racing with this loop
		// can start a new pump run, and a stale snapshot would let this resolve
		// while that new run still has undelivered events.
		while (!this.abandoned && this.pumping) {
			await this.tail;
		}
		if (!this.abandoned && this.failed) {
			throw this.failure;
		}
	}

	private async pump(): Promise<void> {
		while (this.queue.length > 0) {
			const event = this.queue.shift() as AgentEvent;
			try {
				await Promise.resolve(this.emit(event));
			} catch (err) {
				this.failed = true;
				this.failure = err;
				this.queue.length = 0;
				break;
			}
		}
		this.pumping = false;
	}
}

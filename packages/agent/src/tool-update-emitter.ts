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

	drain(): Promise<void> {
		if (this.abandoned) {
			return Promise.resolve();
		}
		return this.tail;
	}

	private async pump(): Promise<void> {
		while (this.queue.length > 0) {
			const event = this.queue.shift() as AgentEvent;
			try {
				await Promise.resolve(this.emit(event));
			} catch (err) {
				this.failed = true;
				this.queue.length = 0;
				throw err;
			}
		}
		this.pumping = false;
	}
}

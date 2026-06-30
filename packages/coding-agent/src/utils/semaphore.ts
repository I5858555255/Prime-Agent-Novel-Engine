/**
 * Counting semaphore for bounding async concurrency. FIFO: waiters acquire in
 * the order they queued.
 */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) {
			throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
		}
		this.available = permits;
	}

	/** Number of callers currently waiting for a permit. */
	get queueLength(): number {
		return this.waiters.length;
	}

	private async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
		} else {
			this.available += 1;
		}
	}

	/** Run `fn` while holding a permit, releasing it even if `fn` throws. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

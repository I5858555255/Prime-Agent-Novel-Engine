export const SAVED_CATALOG_BATCH_SIZE = 32;
export const SAVED_CATALOG_BATCH_MAX_DELAY_MS = 50;

interface ProgressiveCatalogBatcherOptions {
	maxBatchSize: number;
	maxDelayMs: number;
	onFlush: () => void;
}

export class ProgressiveCatalogBatcher {
	private pendingItems = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(private readonly options: ProgressiveCatalogBatcherOptions) {
		if (!Number.isSafeInteger(options.maxBatchSize) || options.maxBatchSize < 1) {
			throw new Error("Progressive catalog batch size must be a positive integer");
		}
		if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0) {
			throw new Error("Progressive catalog batch delay must be non-negative");
		}
	}

	add(): void {
		if (this.closed) return;
		this.pendingItems += 1;
		if (this.pendingItems >= this.options.maxBatchSize) {
			this.flushPending();
			return;
		}
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.flushPending();
			}, this.options.maxDelayMs);
			this.timer.unref?.();
		}
	}

	finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimer();
		this.pendingItems = 0;
		this.options.onFlush();
	}

	cancel(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimer();
		this.pendingItems = 0;
	}

	private flushPending(): void {
		if (this.closed || this.pendingItems === 0) return;
		this.clearTimer();
		this.pendingItems = 0;
		this.options.onFlush();
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export class SnapshotTransferCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotTransferCancelledError";
	}
}

export class SnapshotDestinationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotDestinationError";
	}
}

export interface SnapshotTransferHandle {
	readonly activeSessionId: string;
	readonly snapshotId: string;
	readonly signal: AbortSignal;
	readonly promise: Promise<void>;
	abort(reason?: Error): void;
}

export interface SnapshotTransferLaunchOptions {
	activeSessionId: string;
	snapshotId: string;
	run: (signal: AbortSignal) => Promise<void>;
	onError: (error: Error) => void | Promise<void>;
	onFinally?: () => void | Promise<void>;
	defer?: boolean;
}

interface SnapshotTransferRecord extends SnapshotTransferHandle {
	controller: AbortController;
}

export class SnapshotTransferRegistry {
	private readonly transfers = new Map<string, SnapshotTransferRecord>();

	constructor(private readonly reportInternalError: (error: Error) => void = () => {}) {}

	launch(options: SnapshotTransferLaunchOptions): SnapshotTransferHandle {
		const previous = this.transfers.get(options.activeSessionId);
		previous?.abort(
			new SnapshotTransferCancelledError(`Snapshot ${previous.snapshotId} was superseded by ${options.snapshotId}`),
		);

		const controller = new AbortController();
		let record!: SnapshotTransferRecord;
		const promise = (async () => {
			if (previous) {
				await previous.promise;
			}
			if (options.defer !== false) {
				await waitForSnapshotTransferTurn(controller.signal);
			}
			throwIfSnapshotTransferAborted(controller.signal);
			try {
				await options.run(controller.signal);
			} catch (error) {
				if (!isSnapshotTransferCancellation(error, controller.signal)) {
					try {
						await options.onError(toError(error));
					} catch (handlerError) {
						this.reportInternalError(toError(handlerError));
					}
				}
			}
		})()
			.catch((error) => {
				if (!isSnapshotTransferCancellation(error, controller.signal)) {
					this.reportInternalError(toError(error));
				}
			})
			.finally(async () => {
				if (this.transfers.get(options.activeSessionId) === record) {
					this.transfers.delete(options.activeSessionId);
				}
				try {
					await options.onFinally?.();
				} catch (error) {
					this.reportInternalError(toError(error));
				}
			});
		record = {
			activeSessionId: options.activeSessionId,
			snapshotId: options.snapshotId,
			signal: controller.signal,
			promise,
			controller,
			abort: (reason = new SnapshotTransferCancelledError(`Snapshot ${options.snapshotId} was cancelled`)) => {
				controller.abort(reason);
			},
		};
		this.transfers.set(options.activeSessionId, record);
		return record;
	}

	get(activeSessionId: string): SnapshotTransferHandle | undefined {
		return this.transfers.get(activeSessionId);
	}

	async cancel(activeSessionId: string, reason: Error): Promise<void> {
		const transfer = this.transfers.get(activeSessionId);
		if (!transfer) {
			return;
		}
		transfer.abort(reason);
		await transfer.promise;
	}

	async cancelAll(reason: Error): Promise<void> {
		const transfers = [...this.transfers.values()];
		for (const transfer of transfers) {
			transfer.abort(reason);
		}
		await Promise.all(transfers.map((transfer) => transfer.promise));
	}
}

interface SnapshotStreamingClient {
	snapshotStreaming?: boolean;
	snapshotActiveSessionIds?: Set<string>;
	snapshotActiveSessionCounts?: Map<string, number>;
	backpressured?: boolean;
}

export function markClientSnapshotStreaming(client: SnapshotStreamingClient, activeSessionId: string): void {
	client.snapshotStreaming = true;
	client.snapshotActiveSessionIds ??= new Set();
	client.snapshotActiveSessionIds.add(activeSessionId);
	client.snapshotActiveSessionCounts ??= new Map();
	client.snapshotActiveSessionCounts.set(
		activeSessionId,
		(client.snapshotActiveSessionCounts.get(activeSessionId) ?? 0) + 1,
	);
}

export function finishClientSnapshotStreaming(client: SnapshotStreamingClient, activeSessionId: string): void {
	const count = client.snapshotActiveSessionCounts?.get(activeSessionId) ?? 1;
	if (count > 1) {
		client.snapshotActiveSessionCounts?.set(activeSessionId, count - 1);
	} else {
		client.snapshotActiveSessionCounts?.delete(activeSessionId);
		client.snapshotActiveSessionIds?.delete(activeSessionId);
	}
	client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
	if (!client.snapshotStreaming) {
		client.backpressured = false;
	}
}

export function throwIfSnapshotTransferAborted(signal: AbortSignal): void {
	if (!signal.aborted) {
		return;
	}
	throw signal.reason instanceof Error
		? signal.reason
		: new SnapshotTransferCancelledError("Snapshot transfer was cancelled");
}

export function isSnapshotTransferCancellation(error: unknown, signal?: AbortSignal): boolean {
	return (
		error instanceof SnapshotTransferCancelledError ||
		(signal?.aborted === true && (error === signal.reason || (error instanceof Error && error.name === "AbortError")))
	);
}

export function waitForSnapshotTransferTurn(signal: AbortSignal): Promise<void> {
	throwIfSnapshotTransferAborted(signal);
	return new Promise((resolve, reject) => {
		const immediate = setImmediate(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
		const onAbort = () => {
			clearImmediate(immediate);
			signal.removeEventListener("abort", onAbort);
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new SnapshotTransferCancelledError("Snapshot transfer was cancelled"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

import { describe, expect, it, vi } from "vitest";
import {
	SnapshotTransferCancelledError,
	SnapshotTransferRegistry,
	waitForSnapshotTransferPromise,
} from "../src/modes/daemon/snapshot-transfer-controller.js";

describe("snapshot transfer registry", () => {
	it("contains rejected fire-and-forget work through its error handler", async () => {
		const onError = vi.fn();
		const reportInternalError = vi.fn();
		const registry = new SnapshotTransferRegistry(reportInternalError);

		const transfer = registry.launch({
			activeSessionId: "active-1",
			snapshotId: "snapshot-1",
			defer: false,
			run: async () => {
				throw new Error("deferred encoder failure");
			},
			onError,
		});
		await transfer.promise;

		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "deferred encoder failure" }),
			transfer.signal,
		);
		expect(reportInternalError).not.toHaveBeenCalled();
		expect(registry.get("active-1")).toBeUndefined();
	});

	it("cancels failure delivery with the active transfer signal", async () => {
		const reportInternalError = vi.fn();
		const registry = new SnapshotTransferRegistry(reportInternalError);
		let started!: () => void;
		const failureDeliveryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const transfer = registry.launch({
			activeSessionId: "active-1",
			snapshotId: "snapshot-1",
			defer: false,
			run: async () => {
				throw new Error("source failed");
			},
			onError: (_error, signal) =>
				new Promise<void>((_resolve, reject) => {
					started();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		await failureDeliveryStarted;
		const cancellation = new SnapshotTransferCancelledError("client detached");

		await registry.cancel("active-1", cancellation);

		expect(transfer.signal.reason).toBe(cancellation);
		expect(reportInternalError).not.toHaveBeenCalled();
		expect(registry.get("active-1")).toBeUndefined();
	});

	it("aborts a waiter without cancelling its shared operation", async () => {
		let finishShared!: (value: string) => void;
		const shared = new Promise<string>((resolve) => {
			finishShared = resolve;
		});
		const controller = new AbortController();
		const waiting = waitForSnapshotTransferPromise(shared, controller.signal);
		const cancellation = new SnapshotTransferCancelledError("client detached");

		controller.abort(cancellation);
		await expect(waiting).rejects.toBe(cancellation);
		finishShared("cached");
		await expect(shared).resolves.toBe("cached");
	});

	it("aborts and settles a previous same-session transfer before starting its replacement", async () => {
		const order: string[] = [];
		const registry = new SnapshotTransferRegistry();
		const first = registry.launch({
			activeSessionId: "active-1",
			snapshotId: "snapshot-1",
			defer: false,
			run: (signal) =>
				new Promise<void>((resolve) => {
					order.push("first:start");
					signal.addEventListener(
						"abort",
						() => {
							order.push("first:abort");
							resolve();
						},
						{ once: true },
					);
				}),
			onError: vi.fn(),
			onFinally: () => {
				order.push("first:finally");
			},
		});
		const second = registry.launch({
			activeSessionId: "active-1",
			snapshotId: "snapshot-2",
			defer: false,
			run: async () => {
				order.push("second:start");
			},
			onError: vi.fn(),
		});

		await Promise.all([first.promise, second.promise]);

		expect(order).toEqual(["first:start", "first:abort", "first:finally", "second:start"]);
		expect(registry.get("active-1")).toBeUndefined();
	});

	it("awaits cancellation and unregisters the active transfer", async () => {
		const registry = new SnapshotTransferRegistry();
		const transfer = registry.launch({
			activeSessionId: "active-1",
			snapshotId: "snapshot-1",
			defer: false,
			run: (signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			onError: vi.fn(),
		});
		const cancellation = new SnapshotTransferCancelledError("session closed");

		await registry.cancel("active-1", cancellation);

		expect(transfer.signal.reason).toBe(cancellation);
		expect(registry.get("active-1")).toBeUndefined();
	});
});

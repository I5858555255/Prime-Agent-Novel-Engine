import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/types.js";
import { MAX_PENDING_TOOL_UPDATES, ToolUpdateEmitter } from "../src/tool-update-emitter.js";

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeEvent(n: number): AgentEvent {
	return { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: n };
}

describe("ToolUpdateEmitter", () => {
	it("should deliver events in push order", async () => {
		const received: number[] = [];
		const emitter = new ToolUpdateEmitter((event) => {
			received.push((event as { partialResult: number }).partialResult);
		});

		for (let i = 0; i < 10; i++) {
			emitter.push(makeEvent(i));
		}
		await emitter.drain();

		expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("should never have more than one sink call in flight", async () => {
		let active = 0;
		let peak = 0;
		const emitter = new ToolUpdateEmitter(async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 0));
			active -= 1;
		});

		for (let i = 0; i < 100; i++) {
			emitter.push(makeEvent(i));
		}
		await emitter.drain();

		expect(peak).toBe(1);
	});

	it("should keep pending state bounded and drop oldest under a flood of pushes", async () => {
		const gate = createDeferred();
		const received: number[] = [];
		const emitter = new ToolUpdateEmitter(async (event) => {
			await gate.promise;
			received.push((event as { partialResult: number }).partialResult);
		});

		const total = 100_000;
		for (let i = 0; i < total; i++) {
			emitter.push(makeEvent(i));
			expect(emitter.pendingCount).toBeLessThanOrEqual(MAX_PENDING_TOOL_UPDATES);
		}

		expect(emitter.droppedUpdates).toBeGreaterThan(0);

		gate.resolve();
		await emitter.drain();

		expect(received.at(-1)).toBe(total - 1);
	});

	it("should drop the oldest queued event, keeping relative order of survivors", async () => {
		const gate = createDeferred();
		const received: number[] = [];
		const emitter = new ToolUpdateEmitter(async (event) => {
			await gate.promise;
			received.push((event as { partialResult: number }).partialResult);
		}, 2);

		// First push starts the in-flight (blocked) call; the next four queue up
		// behind it, overflowing the 2-slot queue down to [3, 4].
		for (let i = 0; i < 5; i++) {
			emitter.push(makeEvent(i));
		}

		expect(emitter.pendingCount).toBe(2);
		expect(emitter.droppedUpdates).toBe(2);

		gate.resolve();
		await emitter.drain();

		expect(received).toEqual([0, 3, 4]);
	});

	it("should resolve drain() only after the final delivery completes", async () => {
		const gate = createDeferred();
		let delivered = false;
		const emitter = new ToolUpdateEmitter(async (event) => {
			const n = (event as { partialResult: number }).partialResult;
			if (n === 2) {
				await gate.promise;
			}
			if (n === 2) {
				delivered = true;
			}
		});

		emitter.push(makeEvent(0));
		emitter.push(makeEvent(1));
		emitter.push(makeEvent(2));

		const drainPromise = emitter.drain();
		let drainSettled = false;
		drainPromise.then(() => {
			drainSettled = true;
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(drainSettled).toBe(false);
		expect(delivered).toBe(false);

		gate.resolve();
		await drainPromise;

		expect(drainSettled).toBe(true);
		expect(delivered).toBe(true);
	});

	it("should reject drain() with the sink's error and stop delivering afterward", async () => {
		const gate = createDeferred();
		const received: number[] = [];
		const boom = new Error("boom");
		const emitter = new ToolUpdateEmitter(async (event) => {
			const n = (event as { partialResult: number }).partialResult;
			if (n === 1) {
				await gate.promise;
				throw boom;
			}
			received.push(n);
		});

		emitter.push(makeEvent(0));
		emitter.push(makeEvent(1));
		emitter.push(makeEvent(2));

		gate.resolve();

		await expect(emitter.drain()).rejects.toBe(boom);
		await expect(emitter.drain()).rejects.toBe(boom);

		expect(received).toEqual([0]);

		emitter.push(makeEvent(3));
		expect(emitter.pendingCount).toBe(0);

		await expect(emitter.drain()).rejects.toBe(boom);
		expect(received).toEqual([0]);
	});

	it("should discard the queue and resolve drain() promptly on abandon()", async () => {
		const gate = createDeferred();
		const received: number[] = [];
		const emitter = new ToolUpdateEmitter(async (event) => {
			await gate.promise;
			received.push((event as { partialResult: number }).partialResult);
		});

		emitter.push(makeEvent(0));
		emitter.push(makeEvent(1));
		emitter.push(makeEvent(2));

		expect(emitter.pendingCount).toBe(2);

		let drainSettled = false;
		emitter.abandon();
		const drainPromise = emitter.drain().then(() => {
			drainSettled = true;
		});

		await new Promise((r) => setImmediate(r));
		expect(drainSettled).toBe(true);
		expect(emitter.pendingCount).toBe(0);
		// The in-flight call for event 0 started before abandon() and is not
		// cancelled by it, so drain() resolving promptly must not wait for it.
		expect(received).toEqual([]);

		gate.resolve();
		await drainPromise;
		await new Promise((r) => setImmediate(r));

		// Only the already in-flight event may complete; the queued events (1, 2) must not.
		expect(received).toEqual([0]);
	});

	it("should ignore push() after close() but still deliver events queued before it", async () => {
		const received: number[] = [];
		const emitter = new ToolUpdateEmitter((event) => {
			received.push((event as { partialResult: number }).partialResult);
		});

		emitter.push(makeEvent(0));
		emitter.push(makeEvent(1));
		emitter.close();

		expect(() => emitter.push(makeEvent(2))).not.toThrow();
		emitter.push(makeEvent(3));

		await emitter.drain();

		expect(received).toEqual([0, 1]);
	});

	it("should reject a non-positive-integer maxPending", () => {
		expect(() => new ToolUpdateEmitter(() => {}, 0)).toThrow();
		expect(() => new ToolUpdateEmitter(() => {}, -1)).toThrow();
		expect(() => new ToolUpdateEmitter(() => {}, 1.5)).toThrow();
	});
});

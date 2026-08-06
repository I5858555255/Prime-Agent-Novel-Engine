import { describe, expect, it } from "vitest";
import {
	cachedProcessStartId,
	clearProcessStartIdCacheForTests,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";

describe("cachedProcessStartId", () => {
	it("reuses the observed start id for the same pid within the TTL", () => {
		clearProcessStartIdCacheForTests();
		let calls = 0;
		const lookup = (pid: number) => {
			calls++;
			return `win:${pid}-start`;
		};
		let now = 1_000;

		expect(cachedProcessStartId(42, lookup, () => now)).toBe("win:42-start");
		now += 100;
		expect(cachedProcessStartId(42, lookup, () => now)).toBe("win:42-start");
		now += 100;
		expect(cachedProcessStartId(42, lookup, () => now)).toBe("win:42-start");

		expect(calls).toBe(1);
	});

	it("re-queries once the cache entry expires", () => {
		clearProcessStartIdCacheForTests();
		let calls = 0;
		const lookup = (pid: number) => {
			calls++;
			return `win:${pid}-start-${calls}`;
		};
		let now = 1_000;

		expect(cachedProcessStartId(7, lookup, () => now)).toBe("win:7-start-1");
		now += 5_001; // past the 5000ms TTL
		expect(cachedProcessStartId(7, lookup, () => now)).toBe("win:7-start-2");

		expect(calls).toBe(2);
	});

	it("caches independently per pid", () => {
		clearProcessStartIdCacheForTests();
		const calls: number[] = [];
		const lookup = (pid: number) => {
			calls.push(pid);
			return `win:${pid}`;
		};
		const now = () => 1_000;

		expect(cachedProcessStartId(1, lookup, now)).toBe("win:1");
		expect(cachedProcessStartId(2, lookup, now)).toBe("win:2");
		expect(cachedProcessStartId(1, lookup, now)).toBe("win:1");

		expect(calls).toEqual([1, 2]);
	});

	it("does not produce an already-expired entry when the lookup itself is slower than the TTL", () => {
		clearProcessStartIdCacheForTests();
		let calls = 0;
		let now = 1_000;
		// Simulate a slow synchronous lookup (the real-world powershell.exe spawn
		// this cache exists for) that itself takes longer than the cache TTL.
		// The expiry must be computed from when the lookup RETURNS, not when it
		// STARTED, or the entry is already stale the instant it's stored.
		const lookup = (pid: number) => {
			calls++;
			now += 5_500;
			return `win:${pid}-start`;
		};

		expect(cachedProcessStartId(42, lookup, () => now)).toBe("win:42-start");
		expect(cachedProcessStartId(42, lookup, () => now)).toBe("win:42-start");

		expect(calls).toBe(1);
	});

	it("caches an undefined result too, so a slow negative lookup isn't repeated", () => {
		clearProcessStartIdCacheForTests();
		let calls = 0;
		const lookup = () => {
			calls++;
			return undefined;
		};
		const now = () => 1_000;

		expect(cachedProcessStartId(9, lookup, now)).toBeUndefined();
		expect(cachedProcessStartId(9, lookup, now)).toBeUndefined();

		expect(calls).toBe(1);
	});
});

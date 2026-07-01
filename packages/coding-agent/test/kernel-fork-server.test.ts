import { afterEach, describe, expect, it } from "vitest";
import { ForkServerUnavailable, forkKernel, isForkServerEnabled } from "../src/core/kernel/fork-server.js";

const FORK_ENV = "PRIME_AGENT_KERNEL_FORKSERVER";

describe("fork-server gating", () => {
	afterEach(() => {
		delete process.env[FORK_ENV];
	});

	it("is disabled unless the flag is set on linux", () => {
		delete process.env[FORK_ENV];
		expect(isForkServerEnabled()).toBe(false);
		process.env[FORK_ENV] = "1";
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
	});

	it("rejects with ForkServerUnavailable when disabled so callers fall back", async () => {
		delete process.env[FORK_ENV];
		await expect(forkKernel({ python: "python3" }, "/tmp/nope/connection.json")).rejects.toBeInstanceOf(
			ForkServerUnavailable,
		);
	});

	it("degrades to ForkServerUnavailable when the interpreter can't start", async () => {
		if (process.platform !== "linux") return;
		process.env[FORK_ENV] = "1";
		// The spawn errors immediately (ENOENT), so markDead fails the ready promise
		// fast rather than waiting out the ready timeout.
		await expect(
			forkKernel({ python: "/nonexistent/python-binary" }, "/tmp/nope/connection.json"),
		).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);
});

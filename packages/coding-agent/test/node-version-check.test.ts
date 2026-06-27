import { describe, expect, test } from "vitest";
import { assertNodeVersion, MIN_NODE_MAJOR } from "../src/cli/node-version-check.js";

function run(version: string) {
	const logs: string[] = [];
	let exitCode: number | null = null;
	const ok = assertNodeVersion({
		version,
		log: (m) => logs.push(m),
		exit: (code) => {
			exitCode = code;
		},
	});
	return { ok, logs, exitCode };
}

describe("assertNodeVersion", () => {
	test("passes on the minimum supported major", () => {
		const { ok, logs, exitCode } = run(`${MIN_NODE_MAJOR}.0.0`);
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
		expect(logs).toHaveLength(0);
	});

	test("passes on a newer major", () => {
		const { ok, exitCode } = run("25.9.0");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("rejects an outdated major with guidance and exit 1", () => {
		const { ok, logs, exitCode } = run("20.18.1");
		expect(ok).toBe(false);
		expect(exitCode).toBe(1);
		const text = logs.join("\n");
		expect(text).toContain(`Node ${MIN_NODE_MAJOR}`);
		expect(text).toContain("20.18.1");
		expect(text).toContain("github.com/PrimeIntellect-ai/prime-agent/releases/latest");
	});

	test("lets an unparseable version through rather than blocking", () => {
		const { ok, exitCode } = run("not-a-version");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});
});

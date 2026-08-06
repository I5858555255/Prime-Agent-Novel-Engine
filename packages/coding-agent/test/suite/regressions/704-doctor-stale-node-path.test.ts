import { describe, expect, it } from "vitest";
import { classifyRuntimeHealth, type DaemonInfo, sortDaemons } from "../../../src/cli/daemon-ps.js";

const missing = () => false;
const present = () => true;

describe("issue #704 doctor must flag a daemon whose spawn paths are gone", () => {
	it("reports broken-runtime when the cached node binary was removed", () => {
		const status = classifyRuntimeHealth(
			"current",
			{ executablePath: "/opt/homebrew/Cellar/node/26.6.0/bin/node", entrypointPath: "/opt/homebrew/lib/cli.js" },
			(path) => path !== "/opt/homebrew/Cellar/node/26.6.0/bin/node",
		);
		expect(status).toBe("broken-runtime");
	});

	it("reports broken-runtime when the entrypoint was removed", () => {
		const status = classifyRuntimeHealth(
			"current",
			{ executablePath: process.execPath, entrypointPath: "/gone/cli.js" },
			(path) => path === process.execPath,
		);
		expect(status).toBe("broken-runtime");
	});

	it("does not flag a bun-binary daemon whose virtual entrypoint never exists on disk", () => {
		const bunPaths = ["/$bunfs/root/prime-agent", "/private/tmp/~BUN/cli.js", "/x/%7EBUN/cli.js"];
		for (const entrypointPath of bunPaths) {
			const status = classifyRuntimeHealth(
				"current",
				{ executablePath: "/usr/local/bin/prime-agent", entrypointPath },
				(path) => path === "/usr/local/bin/prime-agent",
			);
			expect(status).toBe("current");
		}
		// The executable itself must still exist even for bun binaries.
		expect(
			classifyRuntimeHealth(
				"current",
				{ executablePath: "/gone/prime-agent", entrypointPath: "/$bunfs/root/x" },
				missing,
			),
		).toBe("broken-runtime");
	});

	it("keeps current when both spawn paths exist", () => {
		expect(
			classifyRuntimeHealth("current", { executablePath: "/usr/bin/node", entrypointPath: "/x/cli.js" }, present),
		).toBe("current");
	});

	it("does not reclassify daemons without runtime identity or unreachable ones", () => {
		expect(classifyRuntimeHealth("stale", undefined, missing)).toBe("stale");
		expect(classifyRuntimeHealth("unreachable", { executablePath: "/gone" }, missing)).toBe("unreachable");
		expect(classifyRuntimeHealth("orphan-file", { executablePath: "/gone" }, missing)).toBe("orphan-file");
	});

	it("sorts broken-runtime daemons between current and stale", () => {
		const daemon = (status: DaemonInfo["status"], socketPath: string): DaemonInfo => ({
			socketPath,
			status,
			isDefault: false,
		});
		const sorted = sortDaemons([daemon("stale", "/b"), daemon("broken-runtime", "/c"), daemon("current", "/a")]);
		expect(sorted.map((info) => info.status)).toEqual(["current", "broken-runtime", "stale"]);
	});
});

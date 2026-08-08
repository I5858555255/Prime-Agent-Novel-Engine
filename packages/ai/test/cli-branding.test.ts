import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx/esm");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Prime Agent AI command branding", () => {
	it("exposes the branded command and keeps the compatibility alias", () => {
		const packageJson = require(join(packageRoot, "package.json")) as {
			bin?: Record<string, string>;
		};

		expect(packageJson.bin).toEqual({
			"pi-ai": "./dist/cli.js",
			"prime-agent-ai": "./dist/cli.js",
		});
	});

	it("uses the branded command in help output", () => {
		const result = spawnSync(
			process.execPath,
			["--import", tsxLoader, join(packageRoot, "src", "cli.ts"), "--help"],
			{
				cwd: packageRoot,
				encoding: "utf8",
			},
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage: npx prime-agent-ai <command> [provider]");
		expect(result.stdout).not.toContain("@earendil-works/pi-ai");
	});
});

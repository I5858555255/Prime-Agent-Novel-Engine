import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../../../src/core/package-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";

describe("package pattern dependency", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-pattern-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves brace-expanded exclusions for package resources", async () => {
		const agentDir = join(tempDir, "agent");
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		for (const name of ["alpha", "beta", "gamma"]) {
			writeFileSync(join(extensionsDir, `${name}.ts`), "export default function extension() {}\n");
		}

		const settingsManager = SettingsManager.inMemory();
		settingsManager.setExtensionPaths(["extensions", "!extensions/{beta,gamma}.ts"]);
		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});

		const result = await packageManager.resolve();
		const enabledByName = Object.fromEntries(
			result.extensions.map((extension) => [extension.path.split(/[\\/]/).at(-1), extension.enabled]),
		);

		expect(enabledByName).toEqual({
			"alpha.ts": true,
			"beta.ts": false,
			"gamma.ts": false,
		});
	});
});

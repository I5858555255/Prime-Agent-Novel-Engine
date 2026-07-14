import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function writePackageFile(root: string, relativePath: string, content: string): string {
	const filePath = join(root, relativePath);
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, content);
	return filePath;
}

describe("package harness discovery", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-harness-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers pi.harness alongside Agent Skills", async () => {
		const packageDir = join(tempDir, "combined-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "combined-package",
				pi: { skills: ["./skills"], harness: ["./harness"] },
			}),
		);
		const skillPath = writePackageFile(
			packageDir,
			"skills/reviewer/SKILL.md",
			"---\nname: reviewer\ndescription: Review code\n---\n",
		);
		const memoryPath = writePackageFile(packageDir, "harness/memory/reviewer.json", "{}");
		const promptPath = writePackageFile(packageDir, "harness/prompt/policy.json", "{}");
		settingsManager.setPackages([packageDir]);

		const resolved = await packageManager.resolve();

		expect(resolved.skills).toContainEqual(
			expect.objectContaining({
				path: skillPath,
				enabled: true,
				metadata: expect.objectContaining({ scope: "user" }),
			}),
		);
		expect(new Set(resolved.harness.map((resource) => resource.path))).toEqual(new Set([memoryPath, promptPath]));
		expect(resolved.harness.every((resource) => resource.enabled && resource.metadata.origin === "package")).toBe(
			true,
		);
	});

	it("applies PackageSource harness filters independently", async () => {
		const packageDir = join(tempDir, "filtered-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "filtered-package", pi: { harness: ["./harness"] } }),
		);
		const keepPath = writePackageFile(packageDir, "harness/memory/keep.json", "{}");
		const dropPath = writePackageFile(packageDir, "harness/memory/drop.json", "{}");
		settingsManager.setPackages([
			{
				source: packageDir,
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
				harness: ["harness/memory/keep.json"],
			},
		]);

		const resolved = await packageManager.resolve();

		expect(resolved.harness).toContainEqual(expect.objectContaining({ path: keepPath, enabled: true }));
		expect(resolved.harness).toContainEqual(expect.objectContaining({ path: dropPath, enabled: false }));
		expect(resolved.extensions).toEqual([]);
		expect(resolved.prompts).toEqual([]);
		expect(resolved.themes).toEqual([]);
	});
});

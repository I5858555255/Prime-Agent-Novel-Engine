import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";

describe("built-in Python skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-agent-builtin-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads websearch by default", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((s) => s.name === "websearch");
		expect(skill?.filePath).toContain(join("python-skills", "websearch", "SKILL.md"));
		expect(skill?.sourceInfo).toMatchObject({
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
	});

	it("honors noSkills for built-in Python skills", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "websearch")).toBe(false);
	});
});

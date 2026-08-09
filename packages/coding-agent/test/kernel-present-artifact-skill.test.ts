import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledPresentArtifactSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "present-artifact");
	return {
		name: "present-artifact",
		importName: "present_artifact",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("present-artifact skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-present-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "sample.png"), "host-owned test fixture");
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("forwards resolved paths and optional labels without creating model attachments", async () => {
		const requests: Array<Record<string, unknown>> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledPresentArtifactSkill()],
			hostHandlers: {
				"artifact.present": async (payload) => {
					requests.push(payload);
					return {
						artifactId: `artifact-${requests.length}`,
						kind: "image",
						name: "sample.png",
						mimeType: "image/png",
						byteSize: 24,
						path: "/captured/sample.png",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
without_label = await present_artifact("sample.png")
with_label = await present_artifact("sample.png", label="Direction A")
print(json.dumps([without_label, with_label], sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toEqual([
			{
				artifactId: "artifact-1",
				byteSize: 24,
				kind: "image",
				mimeType: "image/png",
				name: "sample.png",
				path: "/captured/sample.png",
			},
			{
				artifactId: "artifact-2",
				byteSize: 24,
				kind: "image",
				mimeType: "image/png",
				name: "sample.png",
				path: "/captured/sample.png",
			},
		]);
		expect(requests).toMatchObject([
			{ type: "artifact.present", path: join(tempDir, "sample.png") },
			{ type: "artifact.present", path: join(tempDir, "sample.png"), label: "Direction A" },
		]);
		expect(result.attachments).toBeUndefined();
	});

	it("surfaces host errors as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledPresentArtifactSkill()],
			hostHandlers: {
				"artifact.present": async () => {
					throw new Error("artifact capture failed");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await present_artifact("sample.png")
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("RuntimeError: artifact capture failed");
		expect(result.attachments).toBeUndefined();
	});
});

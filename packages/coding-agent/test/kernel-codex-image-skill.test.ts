import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { PRESENTED_ARTIFACT_CUSTOM_TYPE } from "../src/core/messages.js";
import { capturePresentedArtifact } from "../src/core/presented-artifacts.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

interface ImageInfo {
	bytes: number;
	has_alpha: boolean;
	height: number;
	file: string;
	mime_type: string;
	path: string;
	sha256: string;
	width: number;
}

interface ImageVersion {
	brief: string;
	original_brief: string;
	references: Array<{ file: string; original_name: string; path: string; sha256: string }>;
	image: ImageInfo;
	kind: "icon" | "mockup";
	manifest_path: string;
	parent_version: number | null;
	path: string;
	presentation: { artifactId: string; presentationId: string };
	presented: boolean;
	thread_id: string;
	version: number;
	version_id: string;
	workflow_id: string;
}

interface FakeCodexCall {
	args: string[];
	prompt: string;
}

interface WorkflowOutput {
	allVersions: ImageVersion[];
	approved: {
		approval_path: string;
		approved: boolean;
		exported: boolean;
		status: string;
		source: string;
		target: string;
		version: number;
		workflow_id: string;
	};
	failures: Record<string, string>;
	first: ImageVersion;
	mockup: ImageVersion;
	refined: ImageVersion;
	targetExistedBeforeApproval: boolean;
	versions: ImageVersion[];
}

function bundledCodexImageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "codex-image");
	return {
		name: "codex-image",
		importName: "codex_image",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

const FAKE_CODEX = String.raw`import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt }) + "\n");
process.stderr.write("captured fake Codex diagnostic\n");

if (prompt.includes("AUTH_FAIL")) {
	process.stderr.write("not authenticated; run codex login\n");
	process.exitCode = 1;
} else if (prompt.includes("TIMEOUT")) {
	await new Promise((resolve) => setTimeout(resolve, 10_000));
} else {
	console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fake-imagegen" }));
	if (!prompt.includes("NO_OUTPUT")) {
		const outputLine = prompt.match(/^Staging directory \(JSON\): (.+)$/m);
		if (!outputLine) throw new Error("missing staging directory instruction");
		const stagingDirectory = JSON.parse(outputLine[1]);
		const countPath = process.env.FAKE_CODEX_COUNT;
		const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
		writeFileSync(countPath, String(count));
		const outputDirectory =
			count === 1 ? process.env.CODEX_HOME + "/generated_images/thread-fake-imagegen" : stagingDirectory;
		mkdirSync(outputDirectory, { recursive: true });
		const imagePath = outputDirectory + "/generated-" + count + ".png";
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(imagePath, Buffer.concat([png, Buffer.from([count])]));
		console.log(
			JSON.stringify({
				type: "item.completed",
				item:
					count === 2
						? { type: "image_generation", saved_path: relative(process.cwd(), imagePath) }
						: { type: "image_generation", output_path: imagePath },
			}),
		);
	}
}
`;

describe("codex-image skill over a live kernel", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let sessionDir: string;
	let fakeCodexPath: string;
	let fakeCodexLog: string;
	let fakeCodexCount: string;
	let referencePath: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-codex-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sessionDir = join(tempDir, "session-artifacts");
		fakeCodexPath = join(tempDir, "fake-codex.mjs");
		fakeCodexLog = join(tempDir, "fake-codex.jsonl");
		fakeCodexCount = join(tempDir, "fake-codex-count");
		referencePath = join(tempDir, "reference.png");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(fakeCodexPath, FAKE_CODEX);
		writeFileSync(
			referencePath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				"base64",
			),
		);
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("generates, resumes, presents, records immutable lineage, and gates atomic approval", async () => {
		const presentations: Array<{ label: string; path: string }> = [];
		const presentationMessages: unknown[] = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: {
				RLM_SESSION_DIR: sessionDir,
				FAKE_CODEX_LOG: fakeCodexLog,
				FAKE_CODEX_COUNT: fakeCodexCount,
				CODEX_HOME: join(tempDir, "codex-home"),
			},
			pythonSkills: [bundledCodexImageSkill()],
			hostHandlers: {
				"artifact.present": async (payload) => {
					if (typeof payload.path !== "string" || typeof payload.label !== "string") {
						throw new Error("invalid artifact.present payload");
					}
					const captured = await capturePresentedArtifact(payload, {
						cwd: tempDir,
						artifactDir: sessionDir,
						sessionId: "codex-image-test",
					});
					presentations.push({ path: payload.path, label: payload.label });
					presentationMessages.push(captured.message);
					return { ...captured.receipt };
				},
			},
		});

		const manager = await provisioner.ensure();
		const targetPath = join(tempDir, "approved-icon.png");
		const command = [process.execPath, fakeCodexPath];
		const result = await manager.execute(`
import json
import os
from pathlib import Path

_command = ${JSON.stringify(command)}
_first = await codex_image.generate(
    "A focused compass icon for a hiking app",
    kind="icon",
    references=[${JSON.stringify(referencePath)}],
    label="Compass icon v1",
    command=_command,
)
Path(${JSON.stringify(referencePath)}).unlink()
_refined = await codex_image.refine(
    _first["workflow_id"],
    "Make the needle broader and remove the outer tick marks",
    command=_command,
)
_mockup = await codex_image.generate(
    "A desktop settings screen for the hiking app",
    kind="mockup",
    command=_command,
)
_versions = codex_image.list_versions(_first["workflow_id"])
_all_versions = codex_image.list_versions()
_target = Path(${JSON.stringify(targetPath)})
_failures = {}
_tampered_target = Path(${JSON.stringify(join(tempDir, "tampered-mockup.png"))})
_tampered_path = Path(_mockup["path"])
_tampered_path.chmod(0o644)
_tampered_path.write_bytes(_tampered_path.read_bytes() + b"tampered")
try:
    codex_image.approve(
        _mockup["workflow_id"], _mockup["version"], _tampered_target, approved=True
    )
except RuntimeError as error:
    _failures["tamper"] = str(error)
try:
    codex_image.approve(
        _first["workflow_id"], _refined["version"], _target, approved=False
    )
except PermissionError as error:
    _failures["approval"] = str(error)
_target_existed_before_approval = _target.exists()
_approved = codex_image.approve(
    _first["workflow_id"], _refined["version"], _target, approved=True
)
try:
    codex_image.approve(
        _first["workflow_id"], _refined["version"], _target, approved=True
    )
except FileExistsError as error:
    _failures["collision"] = str(error)

_saved_session_dir = os.environ.pop("RLM_SESSION_DIR")
try:
    await codex_image.generate("missing session", command=_command)
except RuntimeError as error:
    _failures["session"] = str(error)
finally:
    os.environ["RLM_SESSION_DIR"] = _saved_session_dir

try:
    await codex_image.generate("missing command", command=["codex-that-does-not-exist"])
except RuntimeError as error:
    _failures["cli"] = str(error)
try:
    await codex_image.generate("AUTH_FAIL", command=_command)
except RuntimeError as error:
    _failures["auth"] = str(error)
try:
    await codex_image.generate("NO_OUTPUT", command=_command)
except RuntimeError as error:
    _failures["output"] = str(error)
try:
    await codex_image.generate("TIMEOUT", command=_command, timeout_seconds=0.05)
except TimeoutError as error:
    _failures["timeout"] = str(error)

print(json.dumps({
    "first": _first,
    "refined": _refined,
    "mockup": _mockup,
    "versions": _versions,
    "allVersions": _all_versions,
    "targetExistedBeforeApproval": _target_existed_before_approval,
    "approved": _approved,
    "failures": _failures,
}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(result.stderr).not.toContain("captured fake Codex diagnostic");
		const output = JSON.parse(result.stdout.trim()) as WorkflowOutput;

		expect(output.first.kind).toBe("icon");
		expect(output.first.version).toBe(1);
		expect(output.first.parent_version).toBeNull();
		expect(output.first.presented).toBe(true);
		expect(output.first.presentation.artifactId).toMatch(/^[a-f0-9]{16}$/);
		expect(output.first.presentation.presentationId).toBeTruthy();
		expect(output.first.image).toMatchObject({ width: 1, height: 1, has_alpha: true });
		expect(output.first.original_brief).toBe(output.first.brief);
		expect(output.first.references).toHaveLength(1);
		expect(output.first.references[0].original_name).toBe("reference.png");
		expect(output.first.references[0].path.startsWith(join(sessionDir, "codex-image"))).toBe(true);
		expect(output.refined.version).toBe(2);
		expect(output.refined.parent_version).toBe(1);
		expect(output.refined.thread_id).toBe(output.first.thread_id);
		expect(output.refined.workflow_id).toBe(output.first.workflow_id);
		expect(output.mockup.kind).toBe("mockup");
		expect(output.versions.map((version) => version.version)).toEqual([1, 2]);
		expect(output.allVersions).toHaveLength(3);
		expect(output.first.path).not.toBe(output.refined.path);
		expect(output.first.path.startsWith(join(sessionDir, "codex-image"))).toBe(true);
		expect(output.refined.path.startsWith(join(sessionDir, "codex-image"))).toBe(true);

		expect(presentations).toEqual([
			{ path: output.first.path, label: "Compass icon v1" },
			{
				path: output.refined.path,
				label: `Codex icon — ${output.first.workflow_id} v0002`,
			},
			{
				path: output.mockup.path,
				label: `Codex mockup — ${output.mockup.workflow_id} v0001`,
			},
		]);

		const firstManifestBefore = readFileSync(output.first.manifest_path, "utf8");
		const firstManifest = JSON.parse(firstManifestBefore) as ImageVersion;
		const refinedManifest = JSON.parse(readFileSync(output.refined.manifest_path, "utf8")) as ImageVersion;
		expect(firstManifest.thread_id).toBe("thread-fake-imagegen");
		expect(firstManifest.parent_version).toBeNull();
		expect(refinedManifest.thread_id).toBe(firstManifest.thread_id);
		expect(refinedManifest.parent_version).toBe(1);
		expect(readFileSync(output.first.manifest_path, "utf8")).toBe(firstManifestBefore);
		expect(statSync(output.first.manifest_path).mode & 0o222).toBe(0);
		expect(statSync(output.first.path).mode & 0o222).toBe(0);

		expect(output.targetExistedBeforeApproval).toBe(false);
		expect(output.failures.approval).toContain("explicit approved=True");
		expect(output.failures.tamper).toContain("no longer match");
		expect(existsSync(join(tempDir, "tampered-mockup.png"))).toBe(false);
		expect(output.failures.collision).toContain("overwrite=True");
		expect(output.approved).toMatchObject({
			approved: true,
			exported: true,
			status: "approved_for_export",
			source: output.refined.path,
			target: targetPath,
			version: 2,
			workflow_id: output.first.workflow_id,
		});
		expect(readFileSync(targetPath)).toEqual(readFileSync(output.refined.path));
		expect(existsSync(output.approved.approval_path)).toBe(true);
		expect(JSON.parse(readFileSync(output.approved.approval_path, "utf8"))).toMatchObject({
			status: "approved_for_export",
			sha256: output.refined.image.sha256,
		});
		expect(readdirSync(tempDir).some((name) => name.includes(".codex-image-") && name.endsWith(".tmp"))).toBe(false);

		expect(output.failures.session).toContain("requires RLM_SESSION_DIR");
		expect(output.failures.cli).toContain("Codex CLI not found");
		expect(output.failures.auth).toContain("Codex authentication failed");
		expect(output.failures.output).toContain("without reporting a generated image path");
		expect(output.failures.timeout).toContain("timed out after 0.05 seconds");
		expect(presentations).toHaveLength(3);
		expect(presentationMessages).toHaveLength(3);
		expect(presentationMessages[0]).toMatchObject({
			customType: PRESENTED_ARTIFACT_CUSTOM_TYPE,
			display: true,
			details: { kind: "image", originalWidth: 1, originalHeight: 1 },
		});
		expect(codexImageWorkflowDirectories(sessionDir)).toHaveLength(2);

		const calls = readFileSync(fakeCodexLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FakeCodexCall);
		const initialCall = calls[0];
		const refinementCall = calls[1];
		const mockupCall = calls[2];
		expect(initialCall.args.slice(0, 2)).toEqual(["exec", "--json"]);
		expect(initialCall.args).toContain("image_generation");
		expect(initialCall.args).toContain("-i");
		expect(initialCall.args).not.toContain(referencePath);
		expect(initialCall.args[initialCall.args.indexOf("-i") + 1]).toContain(join(sessionDir, "codex-image"));
		expect(initialCall.args.at(-1)).toBe("-");
		expect(initialCall.prompt).toContain("native image generation tool (imagegen)");
		expect(initialCall.prompt).toContain("exactly one final icon image");
		expect(initialCall.prompt).not.toContain("comparison-sheet");
		expect(refinementCall.args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
		expect(refinementCall.args).toContain("thread-fake-imagegen");
		expect(refinementCall.args).toContain("-i");
		expect(refinementCall.args.at(-1)).toBe("-");
		expect(refinementCall.prompt).toContain("Requested refinement:");
		expect(mockupCall.prompt).toContain("exactly one final mockup comparison-sheet image");
		expect(mockupCall.prompt).toContain("clearly labeled A, B, and C");
	});
});

function codexImageWorkflowDirectories(sessionDir: string): string[] {
	const storageDir = join(sessionDir, "codex-image");
	return readdirSync(storageDir).filter((name) => name.startsWith("img-"));
}

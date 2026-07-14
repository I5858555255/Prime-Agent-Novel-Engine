import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedResource } from "../src/core/package-manager.js";
import type { RefinementProposal } from "../src/core/refinement/index.js";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
	loadPackageHarness,
	mergeHarnessStates,
} from "../src/core/refinement/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function harnessEntry(kind: HarnessEntry["kind"], id: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind,
		title: `${id} title`,
		content: `${id} content`,
		path: "package/shared",
		reference:
			kind === "skill"
				? {
						type: "python",
						import: "shared_skill",
						callable: "run",
						call_pattern: "await shared_skill.run()",
					}
				: {},
		arguments: {},
		metadata: {},
		source: "package-declaration",
		created_at: TIMESTAMP,
		updated_at: TIMESTAMP,
		version: 1,
		...overrides,
	};
}

function harnessState(entries: HarnessEntry[] = []): HarnessState {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const entry of entries) {
		state.entries[entry.kind][entry.id] = entry;
	}
	return state;
}

type HarnessFileEntry = Pick<HarnessEntry, "kind" | "id"> & Partial<Omit<HarnessEntry, "kind" | "id">>;

function writeHarnessPackage(root: string, entries: HarnessFileEntry[]): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: root, pi: { harness: ["./harness"] } }));
	for (const entry of entries) {
		const kindDir = join(root, "harness", entry.kind);
		mkdirSync(kindDir, { recursive: true });
		writeFileSync(join(kindDir, `${entry.id}.json`), JSON.stringify(entry));
	}
}

describe("package continual harness resources", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-harness-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads the PrimeSkills minimal memory schema and defaults all four harness kinds", async () => {
		const packageDir = join(tempDir, "minimal-package");
		const primeSkillsMemory = {
			kind: "memory",
			id: "primeskills_repo_access_policy",
			title: "PrimeSkills repository access policy",
			path: "PrimeSkills/GitHub permissions",
			content:
				"When creating or repairing PrimeIntellect-ai/prime-skills, ensure GitHub user `sethkarten` has direct admin permission before relying on team grants. Grant `research`, `applied-research`, and `engineering` write access separately, then verify all permissions to avoid lockout.",
			reference: {},
			arguments: {},
			metadata: {
				source: "PrimeSkills repository policy",
			},
		} satisfies HarnessFileEntry;
		writeHarnessPackage(packageDir, [
			primeSkillsMemory,
			{
				kind: "prompt",
				id: "minimal_prompt",
				title: "Minimal prompt",
				content: "Apply the shared package policy.",
			},
			{
				kind: "skill",
				id: "minimal_skill",
				title: "Minimal skill",
				content: "Call the shared Python skill.",
				reference: {
					type: "python",
					import: "shared_skill",
					callable: "run",
				},
			},
			{
				kind: "subagent",
				id: "minimal_subagent",
				title: "Minimal subagent",
				content: "Delegate the shared review task.",
			},
		]);
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
			bundledSkillsDir: null,
		});

		await loader.reload();

		const loaded = loader.getHarness();
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.state.entries.memory.primeskills_repo_access_policy).toMatchObject({
			...primeSkillsMemory,
			source: packageDir,
			created_at: "1970-01-01T00:00:00.000Z",
			updated_at: "1970-01-01T00:00:00.000Z",
			version: 1,
		});
		expect(loaded.state.entries.prompt.minimal_prompt).toMatchObject({
			path: "policy",
			reference: {},
			arguments: {},
			metadata: {},
			version: 1,
		});
		expect(loaded.state.entries.skill.minimal_skill).toMatchObject({
			path: "general",
			arguments: {},
			metadata: {},
		});
		expect(loaded.state.entries.subagent.minimal_subagent).toMatchObject({
			path: "general",
			reference: {},
			arguments: {},
			metadata: {},
		});
	});

	it("rejects package IDs that resolve through plain-object prototypes", async () => {
		const packageDir = join(tempDir, "reserved-id-package");
		writeHarnessPackage(packageDir, [
			{ kind: "memory", id: "safe", title: "Safe", content: "Safe content" },
			{ kind: "memory", id: "__proto__", title: "Unsafe", content: "Unsafe content" },
			{ kind: "memory", id: "constructor", title: "Unsafe", content: "Unsafe content" },
			{ kind: "memory", id: "prototype", title: "Unsafe", content: "Unsafe content" },
			{ kind: "memory", id: "toString", title: "Unsafe", content: "Unsafe content" },
			{ kind: "memory", id: "bad id", title: "Unsafe", content: "Unsafe content" },
		]);
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
			bundledSkillsDir: null,
		});

		await loader.reload();

		const loaded = loader.getHarness();
		expect(Object.keys(loaded.state.entries.memory)).toEqual(["safe"]);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"package harness id __proto__ is reserved",
				"package harness id constructor is reserved",
				"package harness id prototype is reserved",
				"package harness id toString is reserved",
				"package harness id must match [A-Za-z0-9_.-]+",
			]),
		);
	});

	it("validates files and Python skill contracts while skipping invalid entries", async () => {
		const packageDir = join(tempDir, "validation-package");
		writeHarnessPackage(packageDir, [harnessEntry("memory", "valid")]);
		const invalidSkill = harnessEntry("skill", "invalid_skill", { reference: { type: "shell" } });
		const emptyPrompt = harnessEntry("prompt", "empty_prompt", { content: "" });
		mkdirSync(join(packageDir, "harness", "skill"), { recursive: true });
		mkdirSync(join(packageDir, "harness", "prompt"), { recursive: true });
		mkdirSync(join(packageDir, "harness", "memory"), { recursive: true });
		mkdirSync(join(packageDir, "harness", "tool"), { recursive: true });
		mkdirSync(join(packageDir, "other"), { recursive: true });
		writeFileSync(join(packageDir, "harness", "skill", "invalid_skill.json"), JSON.stringify(invalidSkill));
		writeFileSync(join(packageDir, "harness", "prompt", "empty_prompt.json"), JSON.stringify(emptyPrompt));
		writeFileSync(
			join(packageDir, "harness", "memory", "wrong_file_id.json"),
			JSON.stringify(harnessEntry("memory", "different_id")),
		);
		writeFileSync(join(packageDir, "harness", "memory", "not_object.json"), "[]");
		writeFileSync(join(packageDir, "harness", "tool", "unsupported.json"), "{}");
		writeFileSync(join(packageDir, "other", "bad.json"), JSON.stringify(harnessEntry("memory", "bad")));
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "validation-package", pi: { harness: ["./harness", "./other"] } }),
		);

		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});
		await loader.reload();

		const loaded = loader.getHarness();
		expect(Object.keys(loaded.state.entries.memory)).toEqual(["valid"]);
		expect(loaded.state.entries.skill).toEqual({});
		expect(loaded.state.entries.prompt).toEqual({});
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/package harness skill reference.type must be python/,
		);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/content must be a nonempty string/,
		);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/id must match file id wrong_file_id/,
		);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/must contain a JSON object/,
		);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(/unsupported kind tool/);
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
			/harness\/<kind>\/<id>\.json/,
		);
	});

	it("uses project package precedence and diagnoses same-scope collisions", async () => {
		const firstUser = join(tempDir, "first-user");
		const secondUser = join(tempDir, "second-user");
		const project = join(tempDir, "project-package");
		writeHarnessPackage(firstUser, [harnessEntry("memory", "shared", { content: "first user" })]);
		writeHarnessPackage(secondUser, [harnessEntry("memory", "shared", { content: "second user" })]);
		writeHarnessPackage(project, [harnessEntry("memory", "shared", { content: "project" })]);
		const settingsManager = SettingsManager.inMemory({ packages: [firstUser, secondUser] });
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});

		await loader.reload();
		expect(loader.getHarness().state.entries.memory.shared.content).toBe("first user");
		expect(loader.getHarness().diagnostics).toContainEqual(
			expect.objectContaining({
				type: "collision",
				collision: expect.objectContaining({
					resourceType: "harness",
					winnerSource: firstUser,
					loserSource: secondUser,
				}),
			}),
		);

		settingsManager.setProjectPackages([project]);
		await loader.reload();
		expect(loader.getHarness().state.entries.memory.shared.content).toBe("project");
		expect(loader.getHarness().state.entries.memory.shared.provenance).toMatchObject({
			origin: "package",
			scope: "project",
			source: project,
			readOnly: true,
		});
	});

	it("redacts package source credentials from provenance, prompts, and collision diagnostics", () => {
		const firstPackage = join(tempDir, "credential-source-first");
		const secondPackage = join(tempDir, "credential-source-second");
		writeHarnessPackage(firstPackage, [harnessEntry("memory", "shared", { content: "first" })]);
		writeHarnessPackage(secondPackage, [harnessEntry("memory", "shared", { content: "second" })]);
		const firstSource =
			"git:https://oauth2:ghp_winnersecret@example.com/acme/shared.git?access_token=ghp_winnerquery&ref=main#access_token=winnerfragment";
		const secondSource =
			"git:github.com/acme/shared.git?api_key=sk-loserquery&channel=stable#github_pat_loserfragment";
		const resources: ResolvedResource[] = [
			{
				path: join(firstPackage, "harness", "memory", "shared.json"),
				enabled: true,
				metadata: {
					source: firstSource,
					scope: "user",
					origin: "package",
					baseDir: firstPackage,
				},
			},
			{
				path: join(secondPackage, "harness", "memory", "shared.json"),
				enabled: true,
				metadata: {
					source: secondSource,
					scope: "user",
					origin: "package",
					baseDir: secondPackage,
				},
			},
		];

		const loaded = loadPackageHarness(resources);
		const prompt = formatHarnessStateForPrompt(loaded.state);
		const exposedData = `${prompt}\n${JSON.stringify(loaded)}`;

		expect(loaded.state.entries.memory.shared.provenance?.source).toBe(
			"git:https://example.com/acme/shared.git?ref=main#access_token=[redacted]",
		);
		expect(loaded.diagnostics[0]?.collision).toMatchObject({
			winnerSource: "git:https://example.com/acme/shared.git?ref=main#access_token=[redacted]",
			loserSource: "git:github.com/acme/shared.git?api_key=[redacted]&channel=stable#[redacted]",
		});
		expect(exposedData).not.toContain("oauth2");
		expect(exposedData).not.toContain("ghp_winnersecret");
		expect(exposedData).not.toContain("ghp_winnerquery");
		expect(exposedData).not.toContain("winnerfragment");
		expect(exposedData).not.toContain(secondSource);
		expect(exposedData).not.toContain("sk-loserquery");
		expect(exposedData).not.toContain("github_pat_loserfragment");
		expect(resources[0]?.metadata.source).toBe(firstSource);
		expect(resources[1]?.metadata.source).toBe(secondSource);
	});

	it("redacts SCP-like package credentials while preserving the normal git SSH username", () => {
		const packageDir = join(tempDir, "scp-credential-sources");
		writeHarnessPackage(packageDir, [
			harnessEntry("memory", "github_token"),
			harnessEntry("memory", "oauth_token"),
			harnessEntry("memory", "normal_git"),
		]);
		const sources = {
			github_token: "git:github_pat_secret@github.com:org/repo",
			oauth_token: "oauth2:token@host:path",
			normal_git: "git@github.com:org/repo",
		};
		const resources: ResolvedResource[] = Object.entries(sources).map(([id, source]) => ({
			path: join(packageDir, "harness", "memory", `${id}.json`),
			enabled: true,
			metadata: {
				source,
				scope: "user",
				origin: "package",
				baseDir: packageDir,
			},
		}));

		const loaded = loadPackageHarness(resources);
		const exposedData = `${formatHarnessStateForPrompt(loaded.state)}\n${JSON.stringify(loaded)}`;

		expect(loaded.state.entries.memory.github_token.provenance?.source).toBe("git:github.com:org/repo");
		expect(loaded.state.entries.memory.oauth_token.provenance?.source).toBe("host:path");
		expect(loaded.state.entries.memory.normal_git.provenance?.source).toBe("git@github.com:org/repo");
		expect(exposedData).not.toContain("github_pat_secret");
		expect(exposedData).not.toContain("oauth2:token");
		expect(resources.map((resource) => resource.metadata.source)).toEqual(Object.values(sources));
	});

	it("merges read-only overlays, permits editable overrides, and exposes provenance in prompts", async () => {
		const packageDir = join(tempDir, "overlay-package");
		writeHarnessPackage(packageDir, [
			harnessEntry("memory", "shared", { content: "package shared" }),
			harnessEntry("memory", "package_only", { content: "package only" }),
			harnessEntry("skill", "shared", { content: "same id, different kind" }),
		]);
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
			bundledSkillsDir: null,
		});
		await loader.reload();
		const packageState = loader.getHarness().state;
		const globalState = harnessState([
			harnessEntry("memory", "shared", { content: "global", scope: "global", source: "refine" }),
		]);
		const localState = harnessState([
			harnessEntry("memory", "shared", { content: "local", scope: "local", source: "refine" }),
		]);

		const merged = mergeHarnessStates(globalState, localState, packageState);
		expect(Object.keys(merged.entries.memory)).toEqual(["shared", "local:shared", "package_only"]);
		expect(Object.values(merged.entries.memory).map((entry) => entry.content)).toEqual([
			"global",
			"local",
			"package only",
		]);
		expect(merged.entries.skill.shared.content).toBe("same id, different kind");
		expect(Object.values(merged.entries.memory).some((entry) => entry.content === "package shared")).toBe(false);

		const overview = formatHarnessStateForPrompt(merged);
		expect(overview).toContain("Package continual harness entries are read-only runtime overlays");
		expect(overview).toContain("[package:package_only]");
		expect(overview).toContain(`source=${packageDir}`);
		expect(overview).toContain(`file=${join(packageDir, "harness", "memory", "package_only.json")}`);
		const systemPrompt = buildSystemPrompt({
			cwd: tempDir,
			selectedTools: ["ipython"],
			harnessState: merged,
		});
		expect(systemPrompt).toContain("Never update or delete them with `/refine`");

		const mergedReadOnlyState = mergeHarnessStates(harnessState(), undefined, packageState);
		const mergedDelete = applyRefinementProposal(
			mergedReadOnlyState,
			{
				summary: "reject a merged package delete",
				rationale: "contract test",
				expectedOutcome: "the package entry remains",
				edits: [{ action: "delete", kind: "memory", id: "package_only" }],
			},
			{ id: "refine_merged_package_read_only", scope: "local" },
		);
		expect(mergedDelete.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "package harness entry is read-only; create an editable same-id override instead",
		});
		expect(mergedReadOnlyState.entries.memory.package_only.content).toBe("package only");

		const editableState = harnessState();
		const proposal: RefinementProposal = {
			summary: "test read-only package entries",
			rationale: "contract test",
			expectedOutcome: "only an editable override is created",
			edits: [
				{
					action: "update",
					kind: "memory",
					id: "package_only",
					title: "updated",
					content: "updated",
				},
				{ action: "delete", kind: "memory", id: "package_only" },
				{
					action: "create",
					kind: "memory",
					id: "package_only",
					title: "editable override",
					content: "editable content",
				},
			],
		};
		const result = applyRefinementProposal(editableState, proposal, {
			id: "refine_package_read_only",
			scope: "local",
			packageState,
		});
		expect(result.appliedEdits.map((edit) => ({ applied: edit.applied, error: edit.error }))).toEqual([
			{
				applied: false,
				error: "package harness entry is read-only; create an editable same-id override instead",
			},
			{
				applied: false,
				error: "package harness entry is read-only; create an editable same-id override instead",
			},
			{ applied: true, error: undefined },
		]);
		expect(editableState.entries.memory.package_only.content).toBe("editable content");
		expect(packageState.entries.memory.package_only.content).toBe("package only");
		expect(packageState.refinements).toEqual([]);
	});

	it("keeps editable entries ahead of package entries at the compact prompt limit", () => {
		const state = harnessState([
			harnessEntry("memory", "package_first", {
				title: "A package entry",
				path: "a/package",
				provenance: {
					origin: "package",
					source: "shared-package",
					scope: "user",
					file: "/shared/harness/memory/package_first.json",
					readOnly: true,
				},
			}),
			harnessEntry("memory", "editable_last", {
				title: "Z editable entry",
				path: "z/editable",
				scope: "local",
			}),
		]);

		const overview = formatHarnessStateForPrompt(state, { maxEntriesPerKind: 1 });

		expect(overview).toContain("[local:editable_last]");
		expect(overview).not.toContain("[package:package_first]");
		expect(overview).toContain("+1 more memory entries");
	});

	it("re-reads package files on reload and drops removed resources without persisting them", async () => {
		const packageDir = join(tempDir, "reload-package");
		const filePath = join(packageDir, "harness", "memory", "reloadable.json");
		writeHarnessPackage(packageDir, [harnessEntry("memory", "reloadable", { content: "version one" })]);
		const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});

		await loader.reload();
		expect(loader.getHarness().state.entries.memory.reloadable.content).toBe("version one");
		writeFileSync(filePath, JSON.stringify(harnessEntry("memory", "reloadable", { content: "version two" })));
		await loader.reload();
		expect(loader.getHarness().state.entries.memory.reloadable.content).toBe("version two");
		settingsManager.setPackages([]);
		await loader.reload();
		expect(loader.getHarness().state.entries.memory.reloadable).toBeUndefined();
		settingsManager.setPackages([packageDir]);
		await loader.reload();
		expect(loader.getHarness().state.entries.memory.reloadable.content).toBe("version two");
		rmSync(filePath);
		await loader.reload();
		expect(loader.getHarness().state.entries.memory.reloadable).toBeUndefined();
		expect(existsSync(join(agentDir, "harness", "harness_state.json"))).toBe(false);
	});
});

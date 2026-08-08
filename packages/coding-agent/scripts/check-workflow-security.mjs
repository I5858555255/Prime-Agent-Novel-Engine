import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowsDirectory = new URL("../../../.github/workflows/", import.meta.url);
const expectedPermissionsByWorkflow = {
	"build-binaries.yml": {
		build: { contents: "read" },
		"full-ci": { contents: "read" },
		publish: { contents: "write" },
		"release-gate": { contents: "read" },
		"release-context": { contents: "read" },
	},
	"ci.yml": {
		"build-check": { contents: "read" },
		"build-check-test": { contents: "read" },
		"python-runtime": { contents: "read" },
		test: { contents: "read" },
	},
	"nightly-process-stress.yml": {
		"process-stress": { contents: "read" },
	},
	"rollback-release.yml": {
		authorize: { contents: "read" },
		rollback: { contents: "read" },
	},
};

function isWorkflowFilename(name) {
	return /\.ya?ml$/i.test(name);
}

async function readWorkflows() {
	const names = (await readdir(workflowsDirectory)).filter(isWorkflowFilename).sort();
	return Promise.all(
		names.map(async (name) => ({
			name,
			source: await readFile(new URL(name, workflowsDirectory), "utf8"),
		})),
	);
}

function getJobBlocks(source) {
	const lines = source.split("\n");
	const jobsIndex = lines.findIndex((line) => line === "jobs:");
	assert.notEqual(jobsIndex, -1, "workflow must define jobs");

	const starts = [];
	for (let index = jobsIndex + 1; index < lines.length; index += 1) {
		const match = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(lines[index]);
		if (match) starts.push({ index, name: match[1] });
	}

	return starts.map((start, index) => ({
		name: start.name,
		source: lines.slice(start.index, starts[index + 1]?.index ?? lines.length).join("\n"),
	}));
}

function getNamedSteps(jobSource) {
	const lines = jobSource.split("\n");
	const starts = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^      - name: (.+)$/.exec(lines[index]);
		if (match) starts.push({ index, name: match[1] });
	}

	return new Map(
		starts.map((start, index) => [
			start.name,
			lines.slice(start.index, starts[index + 1]?.index ?? lines.length).join("\n"),
		]),
	);
}

test("third-party actions use full commit SHAs with version comments", async () => {
	const workflows = await readWorkflows();
	for (const workflow of workflows) {
		for (const [index, line] of workflow.source.split("\n").entries()) {
			const match = /^\s*uses:\s+([^\s@]+)@([^\s#]+)(?:\s+#\s+(.+))?$/.exec(line);
			if (!match || match[1].startsWith("./") || match[1].startsWith("docker://")) continue;

			assert.match(
				match[2],
				/^[0-9a-f]{40}$/,
				`${workflow.name}:${index + 1} must pin ${match[1]} to a full commit SHA`,
			);
			assert.match(
				match[3] ?? "",
				/^v\d+(?:\.\d+){1,2}.*$/,
				`${workflow.name}:${index + 1} must document the pinned action version`,
			);
		}
	}
});

test("workflow discovery covers both supported YAML extensions", () => {
	const candidates = ["ignored.json", "nightly.yaml", "release.yml", "UPPER.YAML"];
	assert.deepEqual(candidates.filter(isWorkflowFilename), ["nightly.yaml", "release.yml", "UPPER.YAML"]);
});

test("workflows default to no token permissions and grant only allowlisted job permissions", async () => {
	const workflows = await readWorkflows();
	assert.deepEqual(
		workflows.map(({ name }) => name),
		Object.keys(expectedPermissionsByWorkflow).sort(),
		"every workflow must have an explicit permission allowlist",
	);

	for (const workflow of workflows) {
		const document = parse(workflow.source);
		assert.deepEqual(document.permissions, {}, `${workflow.name} must default to no token permissions`);

		const expectedJobs = expectedPermissionsByWorkflow[workflow.name];
		assert.deepEqual(
			Object.keys(document.jobs ?? {}).sort(),
			Object.keys(expectedJobs).sort(),
			`${workflow.name} jobs must match the permission allowlist`,
		);

		for (const [jobName, expectedPermissions] of Object.entries(expectedJobs)) {
			assert.deepEqual(
				document.jobs[jobName].permissions,
				expectedPermissions,
				`${workflow.name} job ${jobName} must use only its allowlisted permissions`,
			);
		}
	}
});

test("R2 credentials are scoped to R2-only mutation steps", async () => {
	const allowedByWorkflow = {
		"build-binaries.yml": new Set([
			"Publish production immutable objects to R2",
			"Publish production installers to R2",
			"Promote production channel in R2",
			"Publish beta immutable objects to R2",
			"Advance beta installers in R2",
			"Advance beta channel in R2",
		]),
		"rollback-release.yml": new Set(["Promote verified stable pointers in R2"]),
	};
	for (const [workflowName, allowedSecretSteps] of Object.entries(allowedByWorkflow)) {
		const source = await readFile(new URL(workflowName, workflowsDirectory), "utf8");
		const allSteps = new Map();
		for (const job of getJobBlocks(source)) {
			for (const [name, step] of getNamedSteps(job.source)) allSteps.set(name, step);
			const jobPrefix = job.source.slice(0, job.source.indexOf("    steps:"));
			assert.doesNotMatch(jobPrefix, /secrets\.R2_/, `${workflowName}/${job.name} must not expose R2 secrets at job scope`);
		}
		for (const [name, step] of allSteps) {
			if (!step.includes("secrets.R2_")) continue;
			assert.ok(allowedSecretSteps.has(name), `${workflowName}/${name} must not receive R2 secrets`);
			assert.match(step, /publish-release\.mjs [a-z0-9-]*r2[a-z0-9-]*/, `${name} must invoke an R2 phase`);
			assert.doesNotMatch(step, /secrets\.GITHUB_TOKEN|\bGH_TOKEN\b|\bgh (?:api|release)\b/);
		}
		for (const name of allowedSecretSteps) {
			const step = allSteps.get(name);
			assert.ok(step, `${workflowName} must define ${name}`);
			for (const secret of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT_URL"]) {
				assert.match(step, new RegExp(`secrets\\.${secret}\\b`), `${name} must scope ${secret} locally`);
			}
		}
	}
});

test("every mutable beta phase has a fresh main guard without R2 credentials", async () => {
	const releaseWorkflow = await readFile(new URL("build-binaries.yml", workflowsDirectory), "utf8");
	const publishJob = getJobBlocks(releaseWorkflow).find((job) => job.name === "publish");
	assert.ok(publishJob, "release workflow must define the publish job");
	const steps = getNamedSteps(publishJob.source);
	const phases = [
		["Check beta freshness before GitHub mirror", "beta_github", "Advance beta GitHub release"],
		["Check beta freshness before installers", "beta_installers", "Advance beta installers in R2"],
		["Check beta freshness before channel promotion", "beta_promotion", "Advance beta channel in R2"],
	];
	for (const [guardName, outputId, mutationName] of phases) {
		const guard = steps.get(guardName);
		assert.ok(guard, `beta publication must define ${guardName}`);
		assert.match(guard, new RegExp(`id: ${outputId}`));
		assert.match(guard, /commits\/\$\{DEFAULT_BRANCH\}/);
		assert.match(guard, /test "\$latest_main_sha" = "\$BUILD_SHA"/);
		assert.doesNotMatch(guard, /secrets\.R2_/);
		assert.match(
			steps.get(mutationName) ?? "",
			new RegExp(`steps\\.${outputId}\\.outputs\\.current == 'true'`),
		);
	}
});

test("Dependabot continues updating pinned GitHub Actions", async () => {
	const dependabot = await readFile(new URL("../../../.github/dependabot.yml", import.meta.url), "utf8");
	assert.match(dependabot, /package-ecosystem:\s+github-actions/);
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowsDirectory = new URL("../../../.github/workflows/", import.meta.url);
const expectedPermissionsByWorkflow = {
	"build-binaries.yml": {
		build: { contents: "read" },
		publish: { contents: "write" },
		"release-context": { contents: "read" },
	},
	"ci.yml": {
		"build-check": { contents: "read" },
		"build-check-test": {},
		test: { contents: "read" },
	},
	"nightly-process-stress.yml": {
		"process-stress": { contents: "read" },
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

test("R2 secrets are available only to R2 upload steps", async () => {
	const releaseWorkflow = await readFile(new URL("build-binaries.yml", workflowsDirectory), "utf8");
	const publishJob = getJobBlocks(releaseWorkflow).find((job) => job.name === "publish");
	assert.ok(publishJob, "release workflow must define the publish job");

	const steps = getNamedSteps(publishJob.source);
	const allowedSecretSteps = new Set([
		"Publish production channel to R2",
		"Publish immutable beta artifacts to R2",
		"Advance beta channel in R2",
	]);

	for (const [name, source] of steps) {
		if (!source.includes("secrets.R2_")) continue;
		assert.ok(allowedSecretSteps.has(name), `${name} must not receive R2 secrets`);
		assert.match(source, /\baws s3 cp\b/, `${name} must upload to R2`);
		assert.doesNotMatch(source, /\bgh (?:api|release)\b/, `${name} must not mix R2 and GitHub publication`);
	}

	for (const name of allowedSecretSteps) {
		const source = steps.get(name);
		assert.ok(source, `release workflow must define ${name}`);
		for (const secret of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT_URL"]) {
			assert.match(source, new RegExp(`secrets\\.${secret}\\b`), `${name} must scope ${secret} locally`);
		}
	}

	const publishPrefix = publishJob.source.slice(0, publishJob.source.indexOf("    steps:"));
	assert.doesNotMatch(publishPrefix, /secrets\.R2_/, "publish job must not expose R2 secrets at job scope");
});

test("beta pointer updates preserve the latest-main guard without sharing R2 credentials", async () => {
	const releaseWorkflow = await readFile(new URL("build-binaries.yml", workflowsDirectory), "utf8");
	const publishJob = getJobBlocks(releaseWorkflow).find((job) => job.name === "publish");
	assert.ok(publishJob, "release workflow must define the publish job");
	const steps = getNamedSteps(publishJob.source);

	const guard = steps.get("Check whether beta should advance");
	assert.ok(guard, "beta publication must check the latest main commit");
	assert.match(guard, /id: beta_context/);
	assert.match(guard, /should_advance=(?:false|true)/);
	assert.doesNotMatch(guard, /secrets\.R2_/);

	const condition = /steps\.beta_context\.outputs\.should_advance == 'true'/;
	assert.match(steps.get("Advance beta channel in R2") ?? "", condition);
	assert.match(steps.get("Advance beta GitHub release") ?? "", condition);
	assert.doesNotMatch(steps.get("Advance beta GitHub release") ?? "", /secrets\.R2_/);
});

test("Dependabot continues updating pinned GitHub Actions", async () => {
	const dependabot = await readFile(new URL("../../../.github/dependabot.yml", import.meta.url), "utf8");
	assert.match(dependabot, /package-ecosystem:\s+github-actions/);
});

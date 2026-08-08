import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowsDirectory = new URL("../../../.github/workflows/", import.meta.url);
const expectedPermissionsByWorkflow = {
	"build-binaries.yml": {
		build: { contents: "read" },
		"full-ci": { contents: "read" },
		"publication-context": { contents: "read" },
		"release-gate": { contents: "read" },
		"release-context": { contents: "read" },
	},
	"publish-release.yml": {
		"authorize-publication": { actions: "read", contents: "read" },
		"beta-github": { actions: "read", contents: "write" },
		"beta-r2-finalize": { actions: "read", contents: "read" },
		"beta-r2-immutable": { actions: "read", contents: "read" },
		"production-github-assets": { actions: "read", contents: "write" },
		"production-github-prepare": { actions: "read", contents: "write" },
		"production-r2-finalize": { actions: "read", contents: "read" },
		"production-r2-immutable": { actions: "read", contents: "read" },
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
		"publish-release.yml": new Set([
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
		const document = parse(source);
		for (const job of getJobBlocks(source)) {
			if (!job.source.includes("secrets.R2_")) continue;
			const expectedPermissions =
				workflowName === "publish-release.yml" ? { actions: "read", contents: "read" } : { contents: "read" };
			assert.deepEqual(
				document.jobs[job.name].permissions,
				expectedPermissions,
				`${workflowName}/${job.name} must not receive a write-capable GitHub token with R2 credentials`,
			);
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

test("write-token publication jobs contain only controlled GitHub mutation steps", async () => {
	const source = await readFile(new URL("publish-release.yml", workflowsDirectory), "utf8");
	const document = parse(source);
	for (const job of getJobBlocks(source)) {
		if (document.jobs[job.name].permissions?.contents !== "write") continue;
		assert.doesNotMatch(job.source, /^\s*uses:/m, `${job.name} must not run third-party actions with a write token`);
		assert.doesNotMatch(job.source, /secrets\.R2_/, `${job.name} must not receive R2 credentials`);
		const steps = getNamedSteps(job.source);
		assert.equal(steps.size, 1, `${job.name} must contain exactly one controlled GitHub mutation step`);
		const step = [...steps.values()][0];
		assert.match(step, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
		assert.match(step, /publish-release\.mjs (?:production-github|beta-github)/);
	}
});

test("publication accepts only a successful gated default-branch release run", async () => {
	const caller = await readFile(new URL("build-binaries.yml", workflowsDirectory), "utf8");
	const publication = await readFile(new URL("publish-release.yml", workflowsDirectory), "utf8");
	const callerDocument = parse(caller);
	const publicationDocument = parse(publication);
	const authorization = publicationDocument.jobs["authorize-publication"];

	assert.equal(callerDocument.jobs["publication-context"].needs, "release-gate");
	assert.match(callerDocument.jobs["publication-context"].steps.at(-1).uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
	assert.equal(
		callerDocument.jobs["publication-context"].steps.at(-1).with.name,
		"prime-agent-publication-context",
	);
	const releaseRunName = callerDocument["run-name"];
	assert.equal(typeof releaseRunName, "string");
	assert.match(releaseRunName, /workflow_run\.conclusion == 'success'/);
	assert.match(releaseRunName, /workflow_run\.event == 'push'/);
	assert.match(releaseRunName, /workflow_run\.head_branch == github\.event\.repository\.default_branch/);
	assert.match(releaseRunName, /workflow_run\.head_repository\.full_name == github\.repository/);
	assert.match(releaseRunName, /Prime Agent release candidate/);
	assert.match(releaseRunName, /Rejected Prime Agent release event/);
	assert.match(publication, /workflow_run:\n\s+workflows: \[Release Prime Agent\]\n\s+types: \[completed\]/);
	assert.match(publicationDocument.concurrency.group, /release-prime-agent/);
	assert.match(publicationDocument.concurrency.group, /workflow_run\.conclusion == 'success'/);
	assert.match(publicationDocument.concurrency.group, /workflow_run\.path == '\.github\/workflows\/build-binaries\.yml'/);
	assert.match(publicationDocument.concurrency.group, /workflow_run\.display_title/);
	assert.deepEqual(authorization.permissions, { actions: "read", contents: "read" });
	assert.equal(authorization.environment, undefined);
	assert.equal(authorization.concurrency, undefined);
	assert.doesNotMatch(JSON.stringify(authorization), /R2_/);
	assert.match(authorization.if, /workflow_run\.conclusion == 'success'/);
	assert.match(authorization.if, /workflow_run\.head_branch == github\.event\.repository\.default_branch/);
	assert.match(authorization.if, /workflow_run\.head_repository\.full_name == github\.repository/);

	const downloadStep = authorization.steps.find((step) => step.name === "Download gated publication context");
	assert.ok(downloadStep);
	assert.match(downloadStep.run, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/);
	assert.match(downloadStep.run, /prime-agent-publication-context/);
	const authorizationStep = authorization.steps.find((step) => step.name === "Authorize completed release gate");
	assert.ok(authorizationStep);
	assert.equal(authorizationStep.name, "Authorize completed release gate");
	assert.match(authorizationStep.run, /release-publication-context\.mjs validate/);
	for (const name of [
		"UPSTREAM_CONCLUSION",
		"UPSTREAM_DISPLAY_TITLE",
		"UPSTREAM_EVENT",
		"UPSTREAM_HEAD_BRANCH",
		"UPSTREAM_HEAD_REPOSITORY",
		"UPSTREAM_HEAD_SHA",
		"UPSTREAM_RUN_ID",
		"UPSTREAM_WORKFLOW_PATH",
	]) {
		assert.ok(Object.hasOwn(authorizationStep.env, name), `authorization must bind ${name}`);
	}
	for (const [jobName, job] of Object.entries(publicationDocument.jobs)) {
		if (jobName === "authorize-publication") continue;
		assert.equal(job.environment, "production", `${jobName} must receive protected publication secrets`);
		assert.ok(
			Array.isArray(job.needs) ? job.needs.includes("authorize-publication") : job.needs === "authorize-publication",
			`${jobName} must depend on publication authorization`,
		);
	}
});

test("beta R2 freshness is checked inside read-token mutation jobs", async () => {
	const workflow = await readFile(new URL("publish-release.yml", workflowsDirectory), "utf8");
	const document = parse(workflow);
	const steps = new Map();
	for (const job of getJobBlocks(workflow)) {
		for (const [name, step] of getNamedSteps(job.source)) steps.set(name, step);
	}
	for (const [name, phase] of [
		["Advance beta installers in R2", "beta-r2-installers"],
		["Advance beta channel in R2", "beta-r2-promote"],
	]) {
		const step = steps.get(name);
		assert.ok(step, `beta publication must define ${name}`);
		assert.match(step, new RegExp(`publish-release\\.mjs ${phase}`));
		assert.match(step, /--default-branch "\$DEFAULT_BRANCH"/);
		assert.doesNotMatch(step, /GH_TOKEN|secrets\.GITHUB_TOKEN/);
	}
	for (const jobName of ["beta-r2-finalize", "beta-r2-immutable"]) {
		assert.deepEqual(document.jobs[jobName].permissions, { actions: "read", contents: "read" });
	}
});

test("Dependabot continues updating pinned GitHub Actions", async () => {
	const dependabot = await readFile(new URL("../../../.github/dependabot.yml", import.meta.url), "utf8");
	assert.match(dependabot, /package-ecosystem:\s+github-actions/);
});

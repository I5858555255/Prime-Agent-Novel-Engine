#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(repoRoot, "packages", "coding-agent", "release");
const contractVersion = "0.0.0-contract";
const contractSourceSha = "0".repeat(40);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const typeScriptCli = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const packages = [
	{
		name: "prime-agent-ai",
		readme: "packages/ai/README.md",
		install: ["prime-agent-ai"],
		runtime: `import { Type, getModel } from "prime-agent-ai";
if (typeof Type !== "object" || typeof getModel !== "function") throw new Error("prime-agent-ai exports missing");
`,
	},
	{
		name: "prime-agent-core",
		readme: "packages/agent/README.md",
		install: ["prime-agent-ai", "prime-agent-core"],
		runtime: `import { Agent } from "prime-agent-core";
import { getModel } from "prime-agent-ai";
if (typeof Agent !== "function" || typeof getModel !== "function") throw new Error("prime-agent-core exports missing");
`,
	},
	{
		name: "prime-agent-tui",
		readme: "packages/tui/README.md",
		install: ["prime-agent-tui"],
		runtime: `import { TUI, Text } from "prime-agent-tui";
if (typeof TUI !== "function" || typeof Text !== "function") throw new Error("prime-agent-tui exports missing");
`,
	},
	{
		name: "prime-agent",
		readme: "packages/coding-agent/docs/sdk.md",
		install: ["prime-agent", "prime-agent-ai"],
		runtime: `import { AuthStorage, createAgentSession } from "prime-agent";
import { getModel } from "prime-agent-ai";
if (typeof AuthStorage !== "function" || typeof createAgentSession !== "function" || typeof getModel !== "function") {
	throw new Error("prime-agent SDK exports missing");
}
`,
	},
];

function artifactFile(packageName) {
	return `${packageName}-${contractVersion}.tgz`;
}

function readRepoFile(relativePath) {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

function extractQuickStart(relativePath) {
	const markdown = readRepoFile(relativePath);
	const heading = "## Quick Start";
	const headingIndex = markdown.indexOf(heading);
	if (headingIndex === -1) {
		throw new Error(`${relativePath}: missing ${heading}`);
	}

	const afterHeading = markdown.slice(headingIndex + heading.length);
	const nextHeadingIndex = afterHeading.search(/^## /m);
	const section = nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex);
	const codeBlock = section.match(/```typescript\r?\n([\s\S]*?)\r?\n```/);
	if (!codeBlock) {
		throw new Error(`${relativePath}: missing TypeScript quick start block`);
	}
	return codeBlock[1];
}

function assertDocumentationContract() {
	const unsupportedInstalls =
		/npm install (?:prime-agent(?:-(?:ai|core|tui))?|@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui))/;
	for (const packageContract of packages) {
		const readme = readRepoFile(packageContract.readme);
		if (unsupportedInstalls.test(readme)) {
			throw new Error(`${packageContract.readme}: contains an unsupported registry install command`);
		}
	}

	const externalProgrammaticDocs = [
		"packages/coding-agent/docs/sdk.md",
		"packages/coding-agent/docs/rpc.md",
		"packages/coding-agent/docs/session-format.md",
	];
	for (const relativePath of externalProgrammaticDocs) {
		if (readRepoFile(relativePath).includes("@earendil-works/pi-")) {
			throw new Error(`${relativePath}: contains inherited external package guidance`);
		}
	}
	const sdkSource = readRepoFile("packages/coding-agent/src/core/sdk.ts");
	if (sdkSource.includes("import { getModel } from '@earendil-works/pi-ai';")) {
		throw new Error("packages/coding-agent/src/core/sdk.ts: contains an inherited package import in public JSDoc");
	}

	const compaction = readRepoFile("packages/coding-agent/docs/compaction.md");
	if (!compaction.includes("runtime compatibility specifier")) {
		throw new Error("packages/coding-agent/docs/compaction.md: does not identify its extension runtime import");
	}

	const tuiQuickStart = extractQuickStart("packages/tui/README.md");
	if (tuiQuickStart.includes("./test/")) {
		throw new Error("packages/tui/README.md: quick start imports an unpublished test file");
	}
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", rejectRun);
		child.once("close", (code) => {
			if (code === 0) {
				resolveRun({ stdout, stderr });
				return;
			}
			rejectRun(
				new Error(
					`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
				),
			);
		});
	});
}

async function listen(server) {
	await new Promise((resolveListen, rejectListen) => {
		const onError = (error) => rejectListen(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Loopback artifact server did not report a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
	if (!server.listening) return;
	await new Promise((resolveClose, rejectClose) => {
		server.close((error) => (error ? rejectClose(error) : resolveClose()));
	});
}

function createArtifactServer(artifactsDir) {
	const prefix = `/releases/v${contractVersion}/`;
	const allowedFiles = new Set(packages.map((packageContract) => artifactFile(packageContract.name)));

	return createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (!requestUrl.pathname.startsWith(prefix)) {
			response.writeHead(404).end();
			return;
		}

		const requestedFile = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
		if (requestedFile !== basename(requestedFile) || !allowedFiles.has(requestedFile)) {
			response.writeHead(404).end();
			return;
		}

		const artifactPath = join(artifactsDir, requestedFile);
		if (!existsSync(artifactPath)) {
			response.writeHead(404).end();
			return;
		}

		response.writeHead(200, { "content-type": "application/gzip" });
		const stream = createReadStream(artifactPath);
		stream.once("error", (error) => response.destroy(error));
		stream.pipe(response);
	});
}

async function validatePackage(packageContract, baseUrl, tempRoot, npmCache) {
	const consumerDir = join(tempRoot, packageContract.name);
	mkdirSync(consumerDir, { recursive: true });
	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify({ name: `${packageContract.name}-contract`, private: true, type: "module" }, null, 2)}\n`,
	);

	const installUrls = packageContract.install.map(
		(packageName) => `${baseUrl}/releases/v${contractVersion}/${artifactFile(packageName)}`,
	);
	await run(
		npmCommand,
		["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...installUrls],
		{
			cwd: consumerDir,
			env: { npm_config_cache: npmCache },
		},
	);

	writeFileSync(join(consumerDir, "quick-start.ts"), `${extractQuickStart(packageContract.readme)}\n`);
	writeFileSync(join(consumerDir, "runtime.mjs"), packageContract.runtime);
	writeFileSync(
		join(consumerDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					skipLibCheck: true,
					strict: true,
					target: "ES2022",
				},
				files: ["quick-start.ts"],
			},
			null,
			2,
		)}\n`,
	);

	await run(process.execPath, [typeScriptCli, "--project", "tsconfig.json"], { cwd: consumerDir });
	await run(process.execPath, ["runtime.mjs"], { cwd: consumerDir });
	console.log(`Validated ${packageContract.name}`);
}

async function main() {
	assertDocumentationContract();
	mkdirSync(releaseRoot, { recursive: true });
	const outputDir = mkdtempSync(join(releaseRoot, "contract-"));
	const tempRoot = mkdtempSync(join(tmpdir(), "prime-agent-release-contract-"));
	const npmCache = join(tempRoot, "npm-cache");
	const artifactsDir = join(outputDir, "artifacts");
	const server = createArtifactServer(artifactsDir);

	try {
		const baseUrl = await listen(server);
		await run(process.execPath, [
			join(repoRoot, "scripts", "pack-prime-agent-release.mjs"),
			"--channel",
			"stable",
			"--version",
			contractVersion,
			"--source-sha",
			contractSourceSha,
			"--base-url",
			baseUrl,
			"--out-dir",
			outputDir,
		]);

		for (const packageContract of packages) {
			await validatePackage(packageContract, baseUrl, tempRoot, npmCache);
		}
	} finally {
		await close(server);
		rmSync(outputDir, { force: true, recursive: true });
		rmSync(tempRoot, { force: true, recursive: true });
	}

	console.log("Release package contract passed.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

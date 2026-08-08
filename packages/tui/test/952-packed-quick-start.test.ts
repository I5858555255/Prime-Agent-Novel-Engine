import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const installedRepositoryRoot = dirname(realpathSync(join(repositoryRoot, "node_modules")));
const publicPackageName = "prime-agent-tui";

interface PackageManifest {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...env },
		maxBuffer: 10 * 1024 * 1024,
	});

	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with exit ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
	}

	return result.stdout.trim();
}

function stagePackageFiles(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const entrySource = join(source, entry.name);
		const entryTarget = join(target, entry.name);
		symlinkSync(entrySource, entryTarget, statSync(entrySource).isDirectory() ? "junction" : "file");
	}
}

function resolveInstalledPackage(name: string, issuer: string): string | undefined {
	let current = issuer;
	let relativeToInstallRoot = relative(installedRepositoryRoot, current);
	while (
		relativeToInstallRoot === "" ||
		(!relativeToInstallRoot.startsWith("..") && !isAbsolute(relativeToInstallRoot))
	) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
		relativeToInstallRoot = relative(installedRepositoryRoot, current);
	}
	return undefined;
}

function stageDeclaredDependencyClosure(rootNames: string[], targetRoot: string): void {
	const stageDependency = (
		name: string,
		issuer: string,
		targetNodeModules: string,
		ancestorSources: ReadonlyMap<string, string>,
		optional: boolean,
	): void => {
		const source = resolveInstalledPackage(name, issuer);
		if (!source) {
			if (optional) return;
			throw new Error(`Installed dependency ${name} was not found from ${issuer}`);
		}
		if (ancestorSources.get(name) === source) return;

		const target = join(targetNodeModules, ...name.split("/"));
		if (existsSync(target)) return;
		stagePackageFiles(source, target);

		const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as PackageManifest;
		const childDependencies = new Map<string, boolean>();
		for (const childName of Object.keys(manifest.dependencies ?? {})) childDependencies.set(childName, false);
		for (const childName of Object.keys(manifest.optionalDependencies ?? {})) {
			if (!childDependencies.has(childName)) childDependencies.set(childName, true);
		}
		for (const childName of Object.keys(manifest.peerDependencies ?? {})) {
			if (!childDependencies.has(childName)) {
				childDependencies.set(childName, manifest.peerDependenciesMeta?.[childName]?.optional === true);
			}
		}

		const childAncestors = new Map(ancestorSources);
		childAncestors.set(name, source);
		for (const [childName, childOptional] of childDependencies) {
			stageDependency(childName, source, join(target, "node_modules"), childAncestors, childOptional);
		}
	};

	for (const name of rootNames) {
		stageDependency(name, installedRepositoryRoot, targetRoot, new Map(), false);
	}
}

function extractQuickStart(readme: string): string {
	const heading = "## Quick Start";
	const headingIndex = readme.indexOf(heading);
	assert.notEqual(headingIndex, -1, `Packed README is missing ${heading}`);
	const quickStartSection = readme.slice(headingIndex + heading.length);
	const codeBlock = quickStartSection.match(/```typescript\r?\n([\s\S]*?)\r?\n```/);
	assert.ok(codeBlock?.[1], "Packed README is missing the Quick Start TypeScript block");
	return `${codeBlock[1]}\n`;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number, output: () => string): Promise<ProcessResult> {
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			rejectExit(new Error(`Quick Start did not exit within ${timeoutMs}ms\nOUTPUT:\n${output()}`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectExit(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function runQuickStart(consumerDir: string): Promise<void> {
	const child = spawn(process.execPath, ["--preserve-symlinks", join(consumerDir, "dist/quick-start.js")], {
		cwd: consumerDir,
		env: { ...process.env, COLUMNS: "80", FORCE_COLOR: "0", LINES: "24" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const output = () => `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
	const exitPromise = waitForExit(child, 10_000, output);

	try {
		await new Promise<void>((resolveRender, rejectRender) => {
			const timeout = setTimeout(() => {
				rejectRender(new Error(`Quick Start did not render within 5000ms\n${output()}`));
			}, 5000);
			const inspectOutput = () => {
				if (!stdout.includes("Welcome to my app!")) return;
				clearTimeout(timeout);
				resolveRender();
			};
			child.stdout.on("data", inspectOutput);
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				rejectRender(
					new Error(`Quick Start exited before rendering (code=${code}, signal=${signal})\n${output()}`),
				);
			});
		});

		child.stdin.write("\x03");
		child.stdin.end();
		const result = await exitPromise;
		assert.equal(result.signal, null, output());
		assert.equal(result.code, 0, output());
		assert.match(stdout, /Welcome to my app!/);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

test("issue #952: packed Quick Start compiles, renders, and stops on Ctrl+C", { timeout: 30_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-tui-952-package-"));
	try {
		const stagingDir = join(tempRoot, "staging");
		const artifactDir = join(tempRoot, "artifacts");
		const npmCacheDir = join(tempRoot, "npm-cache");
		const unpackDir = join(tempRoot, "unpack");
		const consumerDir = join(tempRoot, "consumer");
		const installedPackageDir = join(consumerDir, "node_modules", publicPackageName);
		for (const directory of [stagingDir, artifactDir, npmCacheDir, unpackDir, consumerDir]) {
			mkdirSync(directory, { recursive: true });
		}

		cpSync(join(packageRoot, "package.json"), join(stagingDir, "package.json"));
		cpSync(join(packageRoot, "README.md"), join(stagingDir, "README.md"));
		run(
			resolve(repositoryRoot, "node_modules/.bin/tsgo"),
			[
				"-p",
				join(packageRoot, "tsconfig.build.json"),
				"--outDir",
				join(stagingDir, "dist"),
				"--declarationMap",
				"false",
			],
			packageRoot,
		);
		const tarballName = run(
			"npm",
			["pack", stagingDir, "--ignore-scripts", "--silent", "--pack-destination", artifactDir],
			repositoryRoot,
			{ npm_config_cache: npmCacheDir },
		)
			.split(/\r?\n/)
			.at(-1);
		assert.ok(tarballName, "npm pack did not report a tarball");
		run("tar", ["-xzf", join(artifactDir, tarballName), "-C", unpackDir], repositoryRoot);
		cpSync(join(unpackDir, "package"), installedPackageDir, { recursive: true });

		const packedManifest = JSON.parse(
			readFileSync(join(installedPackageDir, "package.json"), "utf8"),
		) as PackageManifest;
		stageDeclaredDependencyClosure(
			[...Object.keys(packedManifest.dependencies ?? {}), "@types/node"],
			join(consumerDir, "node_modules"),
		);

		const quickStart = extractQuickStart(readFileSync(join(installedPackageDir, "README.md"), "utf8"));
		assert.doesNotMatch(quickStart, /from\s+["']\.\.?\/test\//, "Quick Start imports a repository-only test module");
		writeFileSync(join(consumerDir, "quick-start.ts"), quickStart);
		writeFileSync(
			join(consumerDir, "package.json"),
			`${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
		);
		writeFileSync(
			join(consumerDir, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						lib: ["ES2022"],
						module: "NodeNext",
						moduleResolution: "NodeNext",
						outDir: "dist",
						preserveSymlinks: true,
						rootDir: ".",
						skipLibCheck: false,
						strict: true,
						target: "ES2022",
						types: ["node"],
					},
					include: ["quick-start.ts"],
				},
				null,
				2,
			)}\n`,
		);
		run(resolve(repositoryRoot, "node_modules/.bin/tsgo"), ["-p", "tsconfig.json"], consumerDir);
		await runQuickStart(consumerDir);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const installedRepositoryRoot = dirname(realpathSync(join(repositoryRoot, "node_modules")));
const publicPackageName = "prime-agent-tui";
const tsgoCli = resolve(
	dirname(fileURLToPath(import.meta.resolve("@typescript/native-preview/package.json"))),
	"bin/tsgo.js",
);

function resolveNpmCli(): string {
	const candidates = [
		process.env.npm_execpath,
		resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
		resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
	];
	const npmCli = candidates.find(
		(candidate): candidate is string =>
			typeof candidate === "string" && [".cjs", ".js"].includes(extname(candidate)) && existsSync(candidate),
	);
	if (!npmCli) {
		throw new Error(`Could not resolve npm's JavaScript CLI from ${candidates.filter(Boolean).join(", ")}`);
	}
	return realpathSync(npmCli);
}

const npmCli = resolveNpmCli();

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

	if (result.error) {
		throw new Error(`${command} ${args.join(" ")} could not start: ${result.error.message}`, {
			cause: result.error,
		});
	}
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with exit ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
	}

	return result.stdout.trim();
}

function stagePackageFiles(source: string, target: string): void {
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, {
		dereference: true,
		filter: (entry) => basename(entry) !== "node_modules",
		recursive: true,
	});
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

function waitForClose(child: ReturnType<typeof spawn>): Promise<ProcessResult> {
	return new Promise((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", (code, signal) => {
			resolveExit({ code, signal });
		});
	});
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
	return new Promise((resolveOperation, rejectOperation) => {
		const timeout = setTimeout(() => rejectOperation(new Error(message())), timeoutMs);
		operation.then(
			(value) => {
				clearTimeout(timeout);
				resolveOperation(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				rejectOperation(error);
			},
		);
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
	const closePromise = waitForClose(child);

	try {
		const renderPromise = new Promise<void>((resolveRender) => {
			const inspectOutput = () => {
				if (!stdout.includes("Welcome to my app!")) return;
				resolveRender();
			};
			child.stdout.on("data", inspectOutput);
		});
		await withTimeout(
			Promise.race([
				renderPromise,
				closePromise.then(({ code, signal }) => {
					throw new Error(`Quick Start exited before rendering (code=${code}, signal=${signal})\n${output()}`);
				}),
			]),
			5000,
			() => `Quick Start did not render within 5000ms\n${output()}`,
		);

		child.stdin.write("\x03");
		child.stdin.end();
		const result = await withTimeout(closePromise, 5000, () => `Quick Start did not exit within 5000ms\n${output()}`);
		assert.equal(result.signal, null, output());
		assert.equal(result.code, 0, output());
		assert.match(stdout, /Welcome to my app!/);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await withTimeout(
			closePromise,
			2000,
			() => `Quick Start did not close within 2000ms after termination\n${output()}`,
		);
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
			process.execPath,
			[
				tsgoCli,
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
			process.execPath,
			[npmCli, "pack", stagingDir, "--ignore-scripts", "--silent", "--pack-destination", artifactDir],
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
		run(process.execPath, [tsgoCli, "-p", "tsconfig.json"], consumerDir);
		await runQuickStart(consumerDir);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

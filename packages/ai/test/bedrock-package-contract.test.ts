import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const installedRepositoryRoot = dirname(realpathSync(join(repositoryRoot, "node_modules")));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
	name: string;
	dependencies: Record<string, string>;
};

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...env },
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

function readPackageVersion(packagePath: string): string {
	const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
	if (typeof manifest.version !== "string") throw new Error(`Missing package version in ${packagePath}`);
	return manifest.version;
}

interface InstalledPackageManifest {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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

function stageDeclaredDependencyClosure(rootNames: string[], targetRoot: string): Map<string, string[]> {
	const targetsBySource = new Map<string, string[]>();

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
		const targets = targetsBySource.get(source) ?? [];
		targets.push(target);
		targetsBySource.set(source, targets);

		const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as InstalledPackageManifest;
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
	return targetsBySource;
}

describe("Bedrock package contract", () => {
	it("packs with owned Smithy dependencies and resolves declarations and Node transport paths in isolation", () => {
		expect(packageJson.dependencies["@smithy/types"]).toBe("^4.16.0");
		expect(packageJson.dependencies["@smithy/node-http-handler"]).toBe("^4.9.4");

		const tempRoot = mkdtempSync(join(tmpdir(), "pi-ai-bedrock-package-"));
		try {
			const stagingDir = join(tempRoot, "staging");
			const artifactDir = join(tempRoot, "artifacts");
			const npmCacheDir = join(tempRoot, "npm-cache");
			const unpackDir = join(tempRoot, "unpack");
			const consumerDir = join(tempRoot, "consumer");
			const installedPackageDir = join(consumerDir, "node_modules", ...packageJson.name.split("/"));
			mkdirSync(stagingDir, { recursive: true });
			mkdirSync(artifactDir, { recursive: true });
			mkdirSync(npmCacheDir, { recursive: true });
			mkdirSync(unpackDir, { recursive: true });
			mkdirSync(consumerDir, { recursive: true });

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
			expect(tarballName).toBeTruthy();
			run("tar", ["-xzf", join(artifactDir, tarballName!), "-C", unpackDir], repositoryRoot);
			const packedPackageJson = JSON.parse(readFileSync(join(unpackDir, "package/package.json"), "utf8")) as {
				dependencies: Record<string, string>;
			};
			expect(packedPackageJson.dependencies["@smithy/types"]).toBe("^4.16.0");
			expect(packedPackageJson.dependencies["@smithy/node-http-handler"]).toBe("^4.9.4");
			cpSync(join(unpackDir, "package"), installedPackageDir, { recursive: true });

			const stagedTargets = stageDeclaredDependencyClosure(
				[...Object.keys(packedPackageJson.dependencies), "@types/node"],
				join(consumerDir, "node_modules"),
			);
			const nodeFetchSource = resolveInstalledPackage("node-fetch", installedRepositoryRoot);
			const getUriSource = resolveInstalledPackage("get-uri", installedRepositoryRoot);
			expect(nodeFetchSource).toBeDefined();
			expect(getUriSource).toBeDefined();
			const nodeFetchTarget = stagedTargets.get(nodeFetchSource!)?.[0];
			const getUriTarget = stagedTargets.get(getUriSource!)?.[0];
			expect(nodeFetchTarget).toBeDefined();
			expect(getUriTarget).toBeDefined();
			expect(readPackageVersion(join(nodeFetchTarget!, "node_modules/data-uri-to-buffer/package.json"))).toBe(
				"4.0.1",
			);
			expect(readPackageVersion(join(getUriTarget!, "node_modules/data-uri-to-buffer/package.json"))).toBe("6.0.2");

			writeFileSync(
				join(consumerDir, "public-type-consumer.ts"),
				`import type { BedrockOptions, BedrockThinkingDisplay } from ${JSON.stringify(packageJson.name)};\n` +
					`const display: BedrockThinkingDisplay = "summarized";\n` +
					`const options: BedrockOptions = { region: "us-east-1", thinkingDisplay: display };\n` +
					`void options;\n`,
			);
			writeFileSync(
				join(consumerDir, "tsconfig.public.json"),
				`${JSON.stringify(
					{
						compilerOptions: {
							lib: ["ES2022", "DOM"],
							module: "NodeNext",
							moduleResolution: "NodeNext",
							noEmit: true,
							preserveSymlinks: true,
							// The root barrel exposes unrelated Anthropic and Google declarations whose
							// optional multi-layout imports are not strict-clean in this isolated fixture.
							skipLibCheck: true,
							strict: true,
							target: "ES2022",
							types: ["node"],
						},
						include: ["public-type-consumer.ts"],
					},
					null,
					2,
				)}\n`,
			);
			run(resolve(repositoryRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.public.json"], consumerDir);

			writeFileSync(
				join(consumerDir, "smithy-type-consumer.ts"),
				`import type { BedrockOptions, BedrockThinkingDisplay } from ${JSON.stringify(
					`./node_modules/${packageJson.name}/dist/providers/amazon-bedrock.js`,
				)};\n` +
					`import type { createBedrockNodeRequestHandler } from ${JSON.stringify(
						`./node_modules/${packageJson.name}/dist/providers/amazon-bedrock-node-transport.js`,
					)};\n` +
					`const display: BedrockThinkingDisplay = "summarized";\n` +
					`const options: BedrockOptions = { region: "us-east-1", thinkingDisplay: display };\n` +
					`const requestHandler: ReturnType<typeof createBedrockNodeRequestHandler> = undefined;\n` +
					`void options;\n` +
					`void requestHandler;\n`,
			);
			writeFileSync(
				join(consumerDir, "tsconfig.smithy.json"),
				`${JSON.stringify(
					{
						compilerOptions: {
							lib: ["ES2022", "DOM"],
							module: "NodeNext",
							moduleResolution: "NodeNext",
							noEmit: true,
							preserveSymlinks: true,
							strict: true,
							target: "ES2022",
							types: ["node"],
						},
						include: ["smithy-type-consumer.ts"],
					},
					null,
					2,
				)}\n`,
			);
			run(resolve(repositoryRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.smithy.json"], consumerDir);

			writeFileSync(
				join(consumerDir, "runtime-consumer.mjs"),
				`import { bedrockProviderModule } from ${JSON.stringify(`${packageJson.name}/bedrock-provider`)};\n` +
					`if (typeof bedrockProviderModule.streamBedrock !== "function") throw new Error("Bedrock provider did not resolve");\n`,
			);
			run(process.execPath, ["--preserve-symlinks", "runtime-consumer.mjs"], consumerDir);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps the Node Bedrock transport outside the browser root bundle", async () => {
		const result = await build({
			bundle: true,
			entryPoints: [join(packageRoot, "src/index.ts")],
			format: "esm",
			metafile: true,
			platform: "browser",
			write: false,
		});
		const inputs = Object.keys(result.metafile.inputs);

		expect(inputs.some((input) => input.includes("amazon-bedrock-node"))).toBe(false);
		expect(inputs.some((input) => input.includes("@smithy/node-http-handler"))).toBe(false);
		expect(inputs.some((input) => input.includes("proxy-agent"))).toBe(false);
	});
});

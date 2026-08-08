import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
	name: string;
	dependencies: Record<string, string>;
};

function run(command: string, args: string[], cwd: string): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
	});

	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with exit ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
		);
	}

	return result.stdout.trim();
}

function linkPackage(source: string, target: string): void {
	mkdirSync(dirname(target), { recursive: true });
	symlinkSync(source, target, "junction");
}

describe("Bedrock package contract", () => {
	it("packs with owned Smithy dependencies and resolves declarations and Node transport paths in isolation", () => {
		expect(packageJson.dependencies["@smithy/types"]).toBe("^4.16.0");
		expect(packageJson.dependencies["@smithy/node-http-handler"]).toBe("^4.9.4");

		const tempRoot = mkdtempSync(join(tmpdir(), "pi-ai-bedrock-package-"));
		try {
			const stagingDir = join(tempRoot, "staging");
			const artifactDir = join(tempRoot, "artifacts");
			const unpackDir = join(tempRoot, "unpack");
			const consumerDir = join(tempRoot, "consumer");
			const installedPackageDir = join(consumerDir, "node_modules", ...packageJson.name.split("/"));
			mkdirSync(stagingDir, { recursive: true });
			mkdirSync(artifactDir, { recursive: true });
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

			for (const dependency of Object.keys(packageJson.dependencies)) {
				linkPackage(
					join(repositoryRoot, "node_modules", ...dependency.split("/")),
					join(consumerDir, "node_modules", ...dependency.split("/")),
				);
			}
			linkPackage(join(repositoryRoot, "node_modules/@types/node"), join(consumerDir, "node_modules/@types/node"));

			writeFileSync(
				join(consumerDir, "type-consumer.ts"),
				`import type { BedrockOptions, BedrockThinkingDisplay } from ${JSON.stringify(packageJson.name)};\n` +
					`const display: BedrockThinkingDisplay = "summarized";\n` +
					`const options: BedrockOptions = { region: "us-east-1", thinkingDisplay: display };\n` +
					`void options;\n`,
			);
			writeFileSync(
				join(consumerDir, "tsconfig.json"),
				`${JSON.stringify(
					{
						compilerOptions: {
							lib: ["ES2022", "DOM"],
							module: "NodeNext",
							moduleResolution: "NodeNext",
							noEmit: true,
							preserveSymlinks: true,
							skipLibCheck: true,
							strict: true,
							target: "ES2022",
							types: ["node"],
						},
						include: ["type-consumer.ts"],
					},
					null,
					2,
				)}\n`,
			);
			run(resolve(repositoryRoot, "node_modules/.bin/tsgo"), ["-p", "tsconfig.json"], consumerDir);

			writeFileSync(
				join(consumerDir, "runtime-consumer.mjs"),
				`const { bedrockProviderModule } = await import(${JSON.stringify(`${packageJson.name}/bedrock-provider`)});\n` +
					`if (typeof bedrockProviderModule.streamBedrock !== "function") throw new Error("Bedrock provider did not resolve");\n`,
			);
			run(process.execPath, ["runtime-consumer.mjs"], consumerDir);
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

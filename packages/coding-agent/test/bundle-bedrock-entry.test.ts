import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * pi-ai loads the Bedrock provider through a variable specifier
 * (`importNodeOnlyProvider("./amazon-bedrock.js")`) so browser bundles do not
 * pull in the AWS SDK. esbuild cannot resolve a variable specifier, so it emits
 * no chunk for it and reports no warning, yet the runtime import still resolves
 * relative to the emitted chunk directory. scripts/bundle.mjs therefore declares
 * the provider as an explicit entry point named after that specifier.
 *
 * Nothing in the type system or the bundler couples those two files, so this
 * asserts the coupling directly. When it broke, the unbundled dist/ build kept
 * working and only the published `bin` failed, with
 * "module.streamSimple is not a function" on first use of any Bedrock model.
 */

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleScript = join(packageDir, "scripts", "bundle.mjs");
const registerBuiltins = join(packageDir, "..", "ai", "src", "providers", "register-builtins.ts");

function runtimeSpecifiers(): string[] {
	const source = readFileSync(registerBuiltins, "utf-8");
	return [...source.matchAll(/importNodeOnlyProvider\("\.\/([^"]+)\.js"\)/g)].map((match) => match[1]);
}

function declaredEntryNames(): string[] {
	const source = readFileSync(bundleScript, "utf-8");
	return [...source.matchAll(/out:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("bundled Bedrock provider", () => {
	it("declares a bundle entry for every provider the bundler cannot discover", () => {
		const specifiers = runtimeSpecifiers();
		// Guard the guard: if pi-ai stops using the indirection this test is moot.
		expect(specifiers.length).toBeGreaterThan(0);
		const entries = declaredEntryNames();
		const missing = specifiers.filter((specifier) => !entries.includes(specifier));
		expect(missing).toEqual([]);
	});

	it("bundles the entry into a module shaped like a provider", async () => {
		const result = await build({
			entryPoints: [join(packageDir, "scripts", "bedrock-bundle-entry.js")],
			bundle: true,
			format: "esm",
			platform: "node",
			packages: "external",
			write: false,
			logLevel: "silent",
		});
		const code = result.outputFiles[0].text;
		// loadBedrockProviderModule() destructures exactly these two names.
		expect(code).toMatch(/streamBedrock/);
		expect(code).toMatch(/streamSimpleBedrock/);
	});
});

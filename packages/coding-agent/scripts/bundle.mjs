#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The bundle loads the same code
 * from ~20 chunk files in under half the time. dist/ stays unbundled for
 * library consumers and type resolution; only the bin entry uses the bundle.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 */
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageDir, "dist", "bundle");
let buildId;
try {
	buildId = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
		cwd: dirname(packageDir),
		encoding: "utf8",
	}).trim();
} catch {
	buildId = `release-${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version}`;
}

rmSync(outdir, { recursive: true, force: true });

await build({
	entryPoints: [
		{ in: join(packageDir, "dist", "cli.js"), out: "cli" },
		// pi-ai imports the Bedrock provider through a variable specifier to keep
		// the AWS SDK out of browser bundles, so esbuild cannot discover it and
		// emits no chunk -- leaving the runtime import pointing at a file that was
		// never written. Declaring it as an entry emits it under the exact name the
		// runtime looks for, while splitting keeps it a lazily loaded chunk.
		{ in: join(packageDir, "scripts", "bedrock-bundle-entry.js"), out: "amazon-bedrock" },
	],
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	// Native or interop-sensitive packages stay external; they resolve from
	// node_modules at runtime (and are loaded via createRequire/lazily anyway).
	external: ["zeromq", "koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
	define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: JSON.stringify(buildId) },
	banner: {
		js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
	},
	logLevel: "warning",
});

chmodSync(join(outdir, "cli.js"), 0o755);

// esbuild cannot see the Bedrock provider import (variable specifier), so it
// cannot warn when the chunk is absent. Without this guard a bundle whose
// runtime import resolves to a missing file ships silently, and every Bedrock
// model fails with "module.streamSimple is not a function".
const bedrockOutput = join(outdir, "amazon-bedrock.js");
if (!existsSync(bedrockOutput)) {
	throw new Error(`bundle is missing ${bedrockOutput}; Bedrock models would fail at runtime`);
}

console.log("bundled dist/cli.js -> dist/bundle/");

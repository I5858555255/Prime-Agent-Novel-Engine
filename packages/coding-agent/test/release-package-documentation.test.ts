import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

function readRepoFile(relativePath: string): string {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("release package documentation", () => {
	it("defines stable, beta, integrity, and update guidance for immutable artifacts", () => {
		const guide = readRepoFile("packages/coding-agent/docs/package-artifacts.md");

		expect(guide).toContain("/stable");
		expect(guide).toContain("/beta");
		expect(guide).toContain("SHA256SUMS");
		expect(guide).toContain("package-lock.json");
		expect(guide).toContain("prime-agent-ai");
		expect(guide).toContain("prime-agent-core");
		expect(guide).toContain("prime-agent-tui");
	});

	it("does not advertise unsupported registry installs in public entry documentation", () => {
		const publicEntryDocs = [
			"packages/agent/README.md",
			"packages/ai/README.md",
			"packages/tui/README.md",
			"packages/coding-agent/docs/sdk.md",
		].map(readRepoFile);

		for (const document of publicEntryDocs) {
			expect(document).not.toMatch(
				/npm install (?:prime-agent(?:-(?:ai|core|tui))?|@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui))/,
			);
		}
	});

	it("uses branded package identities in external programmatic documentation", () => {
		const externalProgrammaticDocs = [
			"packages/coding-agent/docs/sdk.md",
			"packages/coding-agent/docs/rpc.md",
			"packages/coding-agent/docs/session-format.md",
		].map(readRepoFile);

		for (const document of externalProgrammaticDocs) {
			expect(document).not.toContain("@earendil-works/pi-");
		}

		const sdk = externalProgrammaticDocs[0];
		expect(sdk).toContain('from "prime-agent"');
		expect(sdk).toContain('from "prime-agent-ai"');
		const sdkSource = readRepoFile("packages/coding-agent/src/core/sdk.ts");
		expect(sdkSource).not.toContain("import { getModel } from '@earendil-works/pi-ai';");
		expect(sdkSource).toContain("import { getModel } from 'prime-agent-ai';");

		const compaction = readRepoFile("packages/coding-agent/docs/compaction.md");
		expect(compaction).toContain("node_modules/prime-agent/dist/");
		expect(compaction).toContain("runtime compatibility specifier");
	});

	it("keeps the TUI quick start independent of unpublished test files", () => {
		const tuiReadme = readRepoFile("packages/tui/README.md");
		const quickStart = tuiReadme.split("## Quick Start", 2)[1]?.split("## Core API", 1)[0];

		expect(quickStart).toBeDefined();
		expect(quickStart).not.toContain("./test/");
	});

	it("labels inherited package names as runtime compatibility specifiers", () => {
		const packageGuide = readRepoFile("packages/coding-agent/docs/packages.md");

		expect(packageGuide).toContain("runtime compatibility specifiers");
		expect(packageGuide).not.toContain("The workspace still publishes these inherited package names");
	});
});

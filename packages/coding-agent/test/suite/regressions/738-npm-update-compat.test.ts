import { describe, expect, it } from "vitest";
import { normalizeNpmViewVersion } from "../../../src/core/package-manager.js";
import { translatePackageUpdateArgs, updateArgsIncludeSelf } from "../../../src/modes/interactive/interactive-mode.js";

describe("issue #738 defect 1: /update --extensions must spawn the package command", () => {
	it("translates --extensions to the bare package-update form", () => {
		expect(translatePackageUpdateArgs(["--extensions"])).toEqual([]);
	});

	it("translates --extension <source> to a positional source", () => {
		expect(translatePackageUpdateArgs(["--extension", "npm:bigpowers"])).toEqual(["npm:bigpowers"]);
	});

	it("keeps positional sources and drops daemon-socket plumbing", () => {
		expect(translatePackageUpdateArgs(["npm:bigpowers", "--daemon-socket", "/tmp/x.sock"])).toEqual([
			"npm:bigpowers",
		]);
	});

	it("agrees with updateArgsIncludeSelf about what is a package update", () => {
		// Every arg shape the TUI routes to the package path must translate
		// into something `package update` accepts (no legacy flags).
		for (const args of [["--extensions"], ["--extension", "npm:x"], ["npm:x"]]) {
			expect(updateArgsIncludeSelf(args)).toBe(false);
			const translated = translatePackageUpdateArgs(args);
			expect(translated.some((a) => a === "--extensions" || a === "--extension" || a === "--self")).toBe(false);
		}
	});
});

describe("issue #738 defect 2: npm >= 11 emits a JSON array from npm view", () => {
	it("normalizes the npm 11+ array form", () => {
		expect(normalizeNpmViewVersion('["2.87.2"]\n')).toBe("2.87.2");
	});

	it("keeps the npm 10 bare-string form", () => {
		expect(normalizeNpmViewVersion('"2.87.2"\n')).toBe("2.87.2");
	});

	it("takes the newest entry when several versions are listed", () => {
		expect(normalizeNpmViewVersion('["2.87.1","2.87.2"]')).toBe("2.87.2");
	});

	it("rejects empty and malformed output loudly", () => {
		expect(() => normalizeNpmViewVersion("")).toThrow("Empty response");
		expect(() => normalizeNpmViewVersion("[]")).toThrow("Unexpected npm view version output");
		expect(() => normalizeNpmViewVersion("42")).toThrow("Unexpected npm view version output");
	});

	it("equality against the installed version works after normalization", () => {
		// The false-positive mechanism: ["2.87.2"] !== "2.87.2" was always true.
		expect(normalizeNpmViewVersion('["2.87.2"]')).toBe("2.87.2");
	});
});

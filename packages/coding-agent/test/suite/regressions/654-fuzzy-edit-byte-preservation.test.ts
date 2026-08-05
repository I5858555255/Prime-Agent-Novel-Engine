import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeEditsDiff } from "../../../src/core/tools/edit-diff.js";
import { createEditTool } from "../../../src/index.js";

const editTool = createEditTool(process.cwd());

describe("edit tool fuzzy byte preservation", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-byte-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("preserves unrelated bytes under a single fuzzy edit", async () => {
		const testFile = join(testDir, "single-fuzzy.txt");
		const prefix =
			"nbsp: alpha\u00A0beta\n" +
			"single quotes: \u2018left\u2019\n" +
			"double quotes: \u201Cright\u201D\n" +
			"dash: before\u2014after\n" +
			"ligature: \uFB01le\n" +
			"fraction: \u00BD cup\n" +
			"trailing whitespace stays   \n";
		const target = "console.log('x');";
		const suffix = "\nfinal: untouched\u00A0value   \n";
		const original = prefix + target + suffix;
		const replacement = "console.log('y');";
		writeFileSync(testFile, original);

		await editTool.execute("fuzzy-byte-single", {
			path: testFile,
			edits: [{ oldText: "console.log(\u2018x\u2019);", newText: replacement }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(prefix + replacement + suffix);
	});

	it("replaces only the matched span", async () => {
		const testFile = join(testDir, "matched-span.txt");
		const target = "const message = \u201CHello\u201D;\n";
		const original = `header: \u00BD and \uFB01\n${target}footer: a\u00A0b   \n`;
		const targetIndex = original.indexOf(target);
		const replacement = 'const message = "Goodbye";\n';
		const expected = original.slice(0, targetIndex) + replacement + original.slice(targetIndex + target.length);
		writeFileSync(testFile, original);

		await editTool.execute("fuzzy-byte-span", {
			path: testFile,
			edits: [{ oldText: 'const message = "Hello";\n', newText: replacement }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("mixed exact and fuzzy multi-edit preserves untouched bytes", async () => {
		const testFile = join(testDir, "mixed-multi.txt");
		const original =
			"decoy: \u201Cquoted\u201D \u2014 \u00BD \uFB01\n" +
			"const exact = 1;\n" +
			"hello\u00A0world\n" +
			"trailing decoy   \n";
		const expected =
			"decoy: \u201Cquoted\u201D \u2014 \u00BD \uFB01\n" +
			"const exact = 2;\n" +
			"hello universe\n" +
			"trailing decoy   \n";
		writeFileSync(testFile, original);

		await editTool.execute("fuzzy-byte-mixed", {
			path: testFile,
			edits: [
				{ oldText: "const exact = 1;\n", newText: "const exact = 2;\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("rejects a fuzzy match whose boundary falls inside an NFKC expansion", async () => {
		const testFile = join(testDir, "nfkc-boundary.txt");
		const original = "\u00BD cup sugar\n";
		writeFileSync(testFile, original);

		await expect(
			editTool.execute("fuzzy-byte-nfkc-boundary", {
				path: testFile,
				edits: [{ oldText: "/2 cup sugar", newText: "one cup sugar" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(original);
	});

	it("consumes stripped trailing whitespace at a fuzzy match end boundary", async () => {
		const testFile = join(testDir, "trailing-boundary.txt");
		writeFileSync(testFile, "foo();   \nbar();\n");

		await editTool.execute("fuzzy-byte-trailing-boundary", {
			path: testFile,
			edits: [{ oldText: "foo();\n", newText: "baz();\n" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("baz();\nbar();\n");
	});

	it("reported diff reflects the true original content", async () => {
		const testFile = join(testDir, "true-original-diff.txt");
		const unrelatedLine = "const title = \u201Cuntouched\u201D;";
		const normalizedUnrelatedLine = 'const title = "untouched";';
		const original = `${unrelatedLine}\nhello\u00A0world\n`;
		writeFileSync(testFile, original);

		const result = await computeEditsDiff(
			testFile,
			[{ oldText: "hello world\n", newText: "hello universe\n" }],
			process.cwd(),
		);

		expect(result).not.toHaveProperty("error");
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.diff).toContain(unrelatedLine);
		expect(result.diff).not.toContain(normalizedUnrelatedLine);
		const changedLines = result.diff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
		expect(changedLines.some((line) => line.includes(unrelatedLine))).toBe(false);
		expect(changedLines.some((line) => line.includes(normalizedUnrelatedLine))).toBe(false);
		expect(readFileSync(testFile, "utf-8")).toBe(original);
	});

	it("exact match still takes priority and preserves bytes", async () => {
		const testFile = join(testDir, "exact-priority.txt");
		const target = "const exact = 'before';\n";
		const original = `prefix: \u201Csmart\u201D \u00A0 \u00BD\n${target}suffix: \uFB01 \u2014   \n`;
		const targetIndex = original.indexOf(target);
		const replacement = "const exact = 'after';\n";
		const expected = original.slice(0, targetIndex) + replacement + original.slice(targetIndex + target.length);
		writeFileSync(testFile, original);

		await editTool.execute("fuzzy-byte-exact-priority", {
			path: testFile,
			edits: [{ oldText: target, newText: replacement }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("maps a fuzzy match that starts after indentation", async () => {
		const testFile = join(testDir, "indented-fuzzy.txt");
		const prefix = "function outer() {\n\t";
		const target = "console.log(\u2018x\u2019);";
		const suffix = "\n}\n";
		writeFileSync(testFile, prefix + target + suffix);

		await editTool.execute("fuzzy-byte-indent", {
			path: testFile,
			edits: [{ oldText: "console.log('x');", newText: "console.log('y');" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}console.log('y');${suffix}`);
	});

	it("maps a fuzzy match that starts after an interior space", async () => {
		const testFile = join(testDir, "midline-fuzzy.txt");
		const prefix = "const value = ";
		const target = "\u2018hello\u2019;";
		const suffix = "\nuntouched\u00A0line   \n";
		writeFileSync(testFile, prefix + target + suffix);

		await editTool.execute("fuzzy-byte-midline", {
			path: testFile,
			edits: [{ oldText: "'hello';", newText: "'world';" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}'world';${suffix}`);
	});

	it("keeps trailing whitespace when a fuzzy match ends at end-of-line without a newline", async () => {
		const testFile = join(testDir, "eol-no-newline-fuzzy.txt");
		const target = "const x = \u2018a\u2019;";
		const suffix = "   \nnext line\n";
		writeFileSync(testFile, target + suffix);

		await editTool.execute("fuzzy-byte-eol", {
			path: testFile,
			edits: [{ oldText: "const x = 'a';", newText: "const x = 'b';" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(`const x = 'b';${suffix}`);
	});

	it("maps a fuzzy match late in a long line containing a decomposed accent", async () => {
		// Locks the linear grapheme-cluster pass: the line is far beyond the 2048-char
		// exhaustive-scan cap, so a regression there surfaces as a spurious not-found.
		const testFile = join(testDir, "long-nfd-fuzzy.txt");
		const prefix = `cafe\u0301 ${"x = 1; ".repeat(1000)}`;
		const target = "end = \u2018q\u2019;";
		const suffix = "\nnext\u00A0line   \n";
		writeFileSync(testFile, prefix + target + suffix);

		await editTool.execute("fuzzy-byte-long-nfd", {
			path: testFile,
			edits: [{ oldText: "end = 'q';", newText: "end = 'r';" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}end = 'r';${suffix}`);
	});
});

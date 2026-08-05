import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { computeEditsDiff } from "../../../src/core/tools/edit-diff.js";
import { createEditTool } from "../../../src/index.js";
import { createHarness, type Harness } from "../harness.js";

// The tool cwd is never used: every test passes absolute paths under its harness tempDir.
const editTool = createEditTool(process.cwd());
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses) harness.cleanup();
	harnesses.length = 0;
});

describe("edit tool fuzzy byte preservation", () => {
	it("preserves unrelated bytes under a single fuzzy edit", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "single-fuzzy.txt");
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

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "console.log(\u2018x\u2019);", newText: replacement }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(prefix + replacement + suffix);
	});

	it("replaces only the matched span", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "matched-span.txt");
		const target = "const message = \u201CHello\u201D;\n";
		const original = `header: \u00BD and \uFB01\n${target}footer: a\u00A0b   \n`;
		const targetIndex = original.indexOf(target);
		const replacement = 'const message = "Goodbye";\n';
		const expected = original.slice(0, targetIndex) + replacement + original.slice(targetIndex + target.length);
		writeFileSync(testFile, original);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: 'const message = "Hello";\n', newText: replacement }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("mixed exact and fuzzy multi-edit preserves untouched bytes", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "mixed-multi.txt");
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

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [
						{ oldText: "const exact = 1;\n", newText: "const exact = 2;\n" },
						{ oldText: "hello world\n", newText: "hello universe\n" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("rejects a fuzzy match whose boundary falls inside an NFKC expansion", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "nfkc-boundary.txt");
		const original = "\u00BD cup sugar\n";
		writeFileSync(testFile, original);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "/2 cup sugar", newText: "one cup sugar" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		const errorText =
			toolResult?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n") ?? "";
		expect(toolResult?.isError).toBe(true);
		expect(errorText).toMatch(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(original);
	});

	it("consumes stripped trailing whitespace at a fuzzy match end boundary", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "trailing-boundary.txt");
		writeFileSync(testFile, "foo();   \nbar();\n");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "foo();\n", newText: "baz();\n" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe("baz();\nbar();\n");
	});

	it("reported diff reflects the true original content", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "true-original-diff.txt");
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
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "exact-priority.txt");
		const target = "const exact = 'before';\n";
		const original = `prefix: \u201Csmart\u201D \u00A0 \u00BD\n${target}suffix: \uFB01 \u2014   \n`;
		const targetIndex = original.indexOf(target);
		const replacement = "const exact = 'after';\n";
		const expected = original.slice(0, targetIndex) + replacement + original.slice(targetIndex + target.length);
		writeFileSync(testFile, original);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: target, newText: replacement }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(expected);
	});

	it("maps a fuzzy match that starts after indentation", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "indented-fuzzy.txt");
		const prefix = "function outer() {\n\t";
		const target = "console.log(\u2018x\u2019);";
		const suffix = "\n}\n";
		writeFileSync(testFile, prefix + target + suffix);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "console.log('x');", newText: "console.log('y');" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}console.log('y');${suffix}`);
	});

	it("maps a fuzzy match that starts after an interior space", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "midline-fuzzy.txt");
		const prefix = "const value = ";
		const target = "\u2018hello\u2019;";
		const suffix = "\nuntouched\u00A0line   \n";
		writeFileSync(testFile, prefix + target + suffix);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "'hello';", newText: "'world';" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}'world';${suffix}`);
	});

	it("keeps trailing whitespace when a fuzzy match ends at end-of-line without a newline", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		const testFile = join(harness.tempDir, "eol-no-newline-fuzzy.txt");
		const target = "const x = \u2018a\u2019;";
		const suffix = "   \nnext line\n";
		writeFileSync(testFile, target + suffix);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "const x = 'a';", newText: "const x = 'b';" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(`const x = 'b';${suffix}`);
	});

	it("maps a fuzzy match late in a long line containing a decomposed accent", async () => {
		const harness = await createHarness({ tools: [editTool] });
		harnesses.push(harness);
		// Locks the linear grapheme-cluster pass: the line is far beyond the 2048-char
		// exhaustive-scan cap, so a regression there surfaces as a spurious not-found.
		const testFile = join(harness.tempDir, "long-nfd-fuzzy.txt");
		const prefix = `cafe\u0301 ${"x = 1; ".repeat(1000)}`;
		const target = "end = \u2018q\u2019;";
		const suffix = "\nnext\u00A0line   \n";
		writeFileSync(testFile, prefix + target + suffix);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", {
					path: testFile,
					edits: [{ oldText: "end = 'q';", newText: "end = 'r';" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("apply the edit");

		expect(readFileSync(testFile, "utf-8")).toBe(`${prefix}end = 'r';${suffix}`);
	});
});

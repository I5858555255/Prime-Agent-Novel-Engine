import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool schema", () => {
	it("exposes path, old_str, and new_str in the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).toHaveProperty("path");
		expect(definition.parameters.properties).toHaveProperty("old_str");
		expect(definition.parameters.properties).toHaveProperty("new_str");
	});

	it("does not expose legacy fields in the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
		expect(definition.parameters.properties).not.toHaveProperty("edits");
	});

	it("does not add built-in edit guidance to the system prompt", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.promptGuidelines).toBeUndefined();
	});
});

describe("edit tool execution", () => {
	it("replaces a unique string in a file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "test.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "test.txt",
				old_str: "before",
				new_str: "after",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Edited test.txt" }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("fails when old_str is not found", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "missing.txt");
		await writeFile(filePath, "hello\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-2",
				{
					path: "missing.txt",
					old_str: "nonexistent",
					new_str: "replacement",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("fails when old_str appears multiple times", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "dups.txt");
		await writeFile(filePath, "foo foo foo\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-3",
				{
					path: "dups.txt",
					old_str: "foo",
					new_str: "bar",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Found 3 occurrences/);
	});

	it("fails when file does not exist", async () => {
		const dir = await createTempDir();
		const definition = createEditToolDefinition(dir);

		await expect(
			definition.execute(
				"tool-4",
				{
					path: "nonexistent.txt",
					old_str: "hello",
					new_str: "world",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/ENOENT/);
	});
});

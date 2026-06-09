import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
	});

	it("does not add built-in edit guidance to the system prompt", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.promptGuidelines).toBeUndefined();
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in legacy.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});

describe("edit tool rlm-harness interface (old_str/new_str)", () => {
	it("keeps rlm-harness fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("old_str");
		expect(definition.parameters.properties).not.toHaveProperty("new_str");
	});

	it("folds top-level old_str/new_str into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			old_str: "before",
			new_str: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends old_str/new_str replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			old_str: "c",
			new_str: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("prefers oldText/newText over old_str/new_str when both are present", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "from-oldText",
			newText: "to-newText",
			old_str: "from-old_str",
			new_str: "to-new_str",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "from-oldText", newText: "to-newText" }],
		});
	});

	it("prepared old_str/new_str args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "harness.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "harness.txt",
			old_str: "before",
			new_str: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in harness.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("uses old_str/new_str when oldText/newText are non-string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: 123,
			newText: null,
			old_str: "actual-old",
			new_str: "actual-new",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "actual-old", newText: "actual-new" }],
		});
	});

	it("does not fold old_str when new_str is missing", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			old_str: "before",
		});
		// old_str remains in output because it wasn't folded into edits
		expect(prepared).toEqual({
			path: "file.txt",
			old_str: "before",
		});
	});

	it("does not fold new_str when old_str is missing", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			new_str: "after",
		});
		// new_str remains in output because it wasn't folded into edits
		expect(prepared).toEqual({
			path: "file.txt",
			new_str: "after",
		});
	});
});

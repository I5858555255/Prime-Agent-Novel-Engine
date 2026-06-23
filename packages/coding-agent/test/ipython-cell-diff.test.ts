import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderCell(state: ConstructorParameters<typeof IPythonCellComponent>[0]): string {
	return stripAnsi(new IPythonCellComponent(state).render(80).join("\n"));
}

describe("IPythonCellComponent diff rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a streamed diff with absolute line numbers and suppresses the Edited confirmation", () => {
		const out = renderCell({
			code: 'await edit(path="sample.py", old_str="gamma", new_str="GAMMA")',
			details: {
				status: "ok",
				durationMs: 12,
				// IPython reprs the returned string, so the confirmation arrives quoted.
				result: "'Edited sample.py'",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 10 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		// Header carries the path and the +/- line counts.
		expect(out).toContain("edit sample.py");
		expect(out).toMatch(/\+1\s+-1/);
		// Removed line keeps the old line number + content; added line the new one.
		expect(out).toMatch(/11 -.*gamma/);
		expect(out).toMatch(/11 \+.*GAMMA/);
		expect(out).toMatch(/10 .*alpha/);
		// The redundant "Edited sample.py" confirmation must not render as its own line.
		expect(out.split("\n").some((line) => /^\s*'?Edited sample\.py'?\s*$/.test(line.trim()))).toBe(false);
	});

	it("pads every diff row to the full content width on a single background block", () => {
		const out = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(72);
		// Every rendered line is exactly the panel width (no ragged backgrounds).
		expect(out.every((line) => stripAnsi(line).length === 72)).toBe(true);
	});

	it("keeps full width when a wide character straddles the truncation boundary", () => {
		// CJK chars are 2 cells wide; a narrow render forces truncation mid-character.
		const wide = "値".repeat(60);
		const out = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "a.py", oldStr: "x = 1", newStr: `x = "${wide}"`, startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(40);
		// Measure display cells, not code units (CJK chars are 2 cells wide).
		expect(out.every((line) => visibleWidth(line) === 40)).toBe(true);
	});

	it("prefixes the edit header with the cell's status marker", () => {
		const done = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(done).toMatch(/✓ edit a\.ts/);

		const failed = renderCell({
			code: "await edit(...)",
			details: { status: "error", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
			isError: true,
		});
		expect(failed).toMatch(/✗ edit a\.ts/);
	});

	it("wraps a long diff line onto gutter-aligned continuation rows instead of truncating", () => {
		const longLine = `const x = ${Array.from({ length: 20 }, (_, i) => `arg${i}`).join(", ")};`;
		const out = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "const x = 1;", newStr: longLine, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).split("\n");

		// The full content survives across the wrapped rows (nothing truncated away).
		const joined = out.join("");
		expect(joined).toContain("arg0");
		expect(joined).toContain("arg19");
		// The added line spilled onto at least one continuation row.
		const addedRows = out.filter((line) => /arg\d/.test(line));
		expect(addedRows.length).toBeGreaterThan(1);
	});

	it("renders diff rows at the full cli width with no side padding", () => {
		const width = 50;
		const out = new IPythonCellComponent({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "alpha", newStr: "ALPHA", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).render(width);
		// The colored diff rows fill the whole width — no 2-col panel inset.
		const diffRows = out.filter((line) => /alpha|ALPHA/i.test(stripAnsi(line)));
		expect(diffRows.length).toBeGreaterThan(0);
		expect(diffRows.every((line) => visibleWidth(line) === width)).toBe(true);
		// The row starts at column 0, not behind two spaces of panel padding.
		expect(diffRows.every((line) => !stripAnsi(line).startsWith("  "))).toBe(true);
	});

	it("separates the diff from the summary line with a blank line", () => {
		const out = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 4, diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).split("\n");
		// Line 0 is the summary; line 1 is blank; the edit header follows.
		expect(out[0]).toContain("to expand");
		expect(out[1].trim()).toBe("");
		expect(out[2]).toContain("edit a.ts");
	});

	it("shows the full diff in the collapsed view so file changes never hide behind expand", () => {
		const oldStr = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
		const newStr = oldStr
			.split("\n")
			.map((line, i) => (i % 2 === 0 ? line.toUpperCase() : line))
			.join("\n");

		const collapsed = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 9, diffs: [{ path: "big.py", oldStr, newStr, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		// Collapsed keeps the one-line summary but renders the diff under it, in full.
		expect(collapsed).toContain("to expand");
		expect(collapsed).toContain("edit big.py");
		expect(collapsed).toContain("ROW");
		// Every changed row is present — the diff is never truncated when collapsed.
		expect((collapsed.match(/\+.*ROW \d+/g) ?? []).length).toBe(15);
	});

	it("renders multiple files' diffs in the collapsed view", () => {
		const collapsed = renderCell({
			code: "await edit(...); await edit(...)",
			details: {
				status: "ok",
				diffs: [
					{ path: "a.py", oldStr: "one", newStr: "ONE", startLine: 1 },
					{ path: "b.py", oldStr: "two", newStr: "TWO", startLine: 2 },
				],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(collapsed).toContain("edit a.py");
		expect(collapsed).toContain("edit b.py");
		expect(collapsed).toContain("ONE");
		expect(collapsed).toContain("TWO");
	});

	it("keeps non-edit cells collapsed to a single summary line", () => {
		const collapsed = renderCell({
			code: "print('hello')",
			details: { status: "ok", durationMs: 3, stdout: "hello\nworld\nmore\noutput\nlines" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		// No diffs → the collapsed view stays a single line; output hides behind expand.
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("world");
	});

	it("renders multiple diffs from a single cell", () => {
		const out = renderCell({
			code: "await edit(...); await edit(...)",
			details: {
				status: "ok",
				durationMs: 5,
				diffs: [
					{ path: "a.py", oldStr: "one", newStr: "ONE", startLine: 1 },
					{ path: "b.py", oldStr: "two", newStr: "TWO", startLine: 2 },
				],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(out).toContain("edit a.py");
		expect(out).toContain("edit b.py");
	});

	it("coalesces multiple edits to one file into a single block with hunk separators", () => {
		const out = renderCell({
			code: "await edit(...); await edit(...); await edit(...)",
			expanded: true,
			details: {
				status: "ok",
				diffs: [
					{ path: "app.py", oldStr: "a = 1", newStr: "a = 2", startLine: 1 },
					{ path: "app.py", oldStr: "b = 1", newStr: "b = 2", startLine: 50 },
					{ path: "app.py", oldStr: "c = 1", newStr: "c = 2", startLine: 90 },
				],
			},
			executionStarted: true,
			argsComplete: true,
		});
		// One consolidated header for the file, with summed counts.
		expect(out.split("\n").filter((l) => l.includes("edit app.py")).length).toBe(1);
		expect(out).toMatch(/edit app\.py\s+\+3\s+-3/);
		// Non-adjacent hunks are separated by the vertical-ellipsis marker.
		expect(out).toContain("⋮");
		expect((out.match(/⋮/g) ?? []).length).toBe(2);
	});
});

import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { TranscriptPager } from "../src/modes/interactive/components/transcript-pager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

function makeSize(columns: number, rows: number) {
	return { columns, rows };
}

function visibleContent(pager: TranscriptPager, width: number): string[] {
	// Drop the header (first line) and footer (last line).
	return pager.render(width).slice(1, -1).map(stripAnsi);
}

describe("TranscriptPager", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `content ${i}`);
	// rows=12 -> contentHeight = 10
	const makePager = (onClose = () => {}) => new TranscriptPager("Transcript", () => lines, makeSize(40, 12), onClose);

	test("starts at the top of the content", () => {
		const pager = makePager();
		const shown = visibleContent(pager, 40);
		expect(shown[0]).toContain("content 0");
		expect(shown.at(-1)).toContain("content 9");
	});

	test("scrolls down one line at a time", () => {
		const pager = makePager();
		pager.handleInput("\x1b[B"); // down arrow
		const shown = visibleContent(pager, 40);
		expect(shown[0]).toContain("content 1");
	});

	test("page down advances by a content page", () => {
		const pager = makePager();
		pager.handleInput("\x1b[6~"); // page down
		const shown = visibleContent(pager, 40);
		expect(shown[0]).toContain("content 10");
	});

	test("End jumps to the bottom and clamps", () => {
		const pager = makePager();
		pager.handleInput("\x1b[F"); // end
		const shown = visibleContent(pager, 40);
		// 100 lines, 10 visible -> last window starts at line 90.
		expect(shown.at(-1)).toContain("content 99");
		expect(shown[0]).toContain("content 90");
	});

	test("scrolling up past the top clamps to zero", () => {
		const pager = makePager();
		pager.handleInput("\x1b[A"); // up at top
		const shown = visibleContent(pager, 40);
		expect(shown[0]).toContain("content 0");
	});

	test("Esc invokes the close callback", () => {
		let closed = false;
		const pager = makePager(() => {
			closed = true;
		});
		pager.handleInput("\x1b"); // escape
		expect(closed).toBe(true);
	});
});

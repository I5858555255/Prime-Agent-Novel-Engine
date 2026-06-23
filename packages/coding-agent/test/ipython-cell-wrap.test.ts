import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type CellState = ConstructorParameters<typeof IPythonCellComponent>[0];

/**
 * Whether `line` ends with a foreground color still open. The panel background
 * legitimately wraps the whole line, so only a dangling *foreground* color
 * indicates a leak into the trailing padding (and, on screen, into the next
 * line). Tracks fg and bg separately the way the theme emits them: `39` closes
 * fg, `49` closes bg, `0`/empty resets both.
 */
function foregroundLeftOpen(line: string): boolean {
	let fg = false;
	for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0 || code === 39) {
				fg = false;
			} else if (code === 38) {
				// Extended fg color: skip its data params (38;5;n or 38;2;r;g;b) so an
				// RGB component is not mistaken for an SGR code.
				fg = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 48) {
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fg = true;
			}
		}
	}
	return fg;
}

// A long output that is forced to wrap at narrow widths — the original bug.
const WRAPPING_STATE: CellState = {
	code: "import numpy as np\nresult = np.linspace(0, 100, 50)\nprint('the first element of the linspace array is', result[0])",
	content: [
		{
			type: "text",
			text: "the first element of the linspace array is 0.0\nsecond line of output that is also fairly long and will wrap on a small terminal",
		},
	],
	details: {
		status: "ok",
		durationMs: 12,
		stdout:
			"the first element of the linspace array is 0.0\nsecond line of output that is also fairly long and will wrap on a small terminal",
	},
	executionStarted: true,
	argsComplete: true,
	expanded: true,
};

describe("IPythonCellComponent wrapping", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("never leaves a foreground color open at a wrapped line end", () => {
		// Sweep the narrow widths that force code and output lines to wrap.
		for (let width = 20; width <= 60; width++) {
			const lines = new IPythonCellComponent(WRAPPING_STATE).render(width);
			const leaks = lines.filter(foregroundLeftOpen);
			expect(leaks, `width=${width} leaked foreground on ${leaks.length} line(s)`).toHaveLength(0);
		}
	});

	it("pads every wrapped line to exactly the panel width", () => {
		for (const width of [20, 30, 40, 50]) {
			const lines = new IPythonCellComponent(WRAPPING_STATE).render(width);
			expect(
				lines.every((line) => visibleWidth(line) === width),
				`width=${width}`,
			).toBe(true);
		}
	});

	it("renders the same after a resize as a fresh render at the target width", () => {
		// Resizing must look identical to having started at the new size.
		const resized = new IPythonCellComponent(WRAPPING_STATE);
		resized.render(100);
		resized.invalidate();
		const afterResize = resized.render(34);

		const fresh = new IPythonCellComponent(WRAPPING_STATE).render(34);
		expect(afterResize).toEqual(fresh);
	});

	it("leaves non-wrapping (wide) output untouched", () => {
		// At a wide width nothing wraps, so each styled span is already self-contained
		// and we must not append spurious resets.
		const lines = new IPythonCellComponent(WRAPPING_STATE).render(100);
		expect(lines.some(foregroundLeftOpen)).toBe(false);
		// No line should carry a redundant full reset followed only by padding.
		expect(lines.every((line) => visibleWidth(line) === 100)).toBe(true);
	});
});

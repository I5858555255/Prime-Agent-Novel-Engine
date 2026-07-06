/**
 * Fullscreen (alternate-screen) viewport: a scrollable window over the
 * transcript with a dock (editor/footer) pinned to the bottom rows. Frames
 * are a fixed grid painted with absolute addressing and diffed row-by-row;
 * scroll position is application state, not terminal scrollback.
 */

import { isImageLine } from "./terminal-image.js";
import { sliceByColumn, stripAnsi, visibleWidth } from "./utils.js";

const MIN_TRANSCRIPT_ROWS = 3;

// Kitty images span multiple physical rows and cannot be clipped to a window.
const IMAGE_PLACEHOLDER = "\x1b[2m[image — view in inline mode]\x1b[0m";

export interface ScrollInfo {
	following: boolean;
	linesBelow: number;
	linesAbove: number;
}

// Transcript-anchored selection endpoint (line index + visible column), so
// streaming appends and scrolling never shift what is selected.
interface SelectionPoint {
	line: number;
	col: number;
}

type SelectionMode = "transcript" | "frame";

export class FullscreenViewport {
	private scrollTop = 0;
	private following = true;
	private prevFrame: string[] = [];
	private prevWidth = 0;
	private prevHeight = 0;
	private lastMaxScroll = 0;
	private lastWindowHeight = 0;
	private lastTranscript: string[] = [];
	private lastFrame: string[] = [];
	private lastFrameVisibleStart = 0;
	private lastFrameVisibleHeight = 0;
	private frameSelectionRegions: ReadonlyArray<{ line: number; col: number; width: number }> = [];
	private selectionAnchor: SelectionPoint | null = null;
	private selectionHead: SelectionPoint | null = null;
	private selectionMode: SelectionMode | null = null;

	/**
	 * Compose a frame of exactly `height` lines: scrolled transcript window on
	 * top, dock pinned to the bottom. Following pins the window to the
	 * transcript end; otherwise it stays frozen while content appends.
	 */
	composeFrame(transcript: string[], dock: string[], height: number): string[] {
		let dockLines = dock;
		const maxDock = Math.max(0, height - MIN_TRANSCRIPT_ROWS);
		if (dockLines.length > maxDock) {
			// bottom of the dock (editor + footer) wins over widgets above it
			dockLines = dockLines.slice(dockLines.length - maxDock);
		}
		const windowHeight = height - dockLines.length;
		const maxScroll = Math.max(0, transcript.length - windowHeight);

		if (this.following) {
			this.scrollTop = maxScroll;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
		}
		this.lastMaxScroll = maxScroll;
		this.lastWindowHeight = windowHeight;
		this.lastTranscript = transcript;

		const window = transcript.slice(this.scrollTop, this.scrollTop + windowHeight);
		for (let i = 0; i < window.length; i++) {
			if (isImageLine(window[i])) window[i] = IMAGE_PLACEHOLDER;
		}
		this.highlightSelection(window);
		while (window.length < windowHeight) {
			window.push("");
		}
		return [...window, ...dockLines];
	}

	private orderedSelection(): { start: SelectionPoint; end: SelectionPoint } | null {
		const a = this.selectionAnchor;
		const b = this.selectionHead;
		if (!a || !b || (a.line === b.line && a.col === b.col)) return null;
		const flipped = a.line > b.line || (a.line === b.line && a.col > b.col);
		return flipped ? { start: b, end: a } : { start: a, end: b };
	}

	// Per-line selected column span, or null when the line is outside the selection.
	private selectionSpan(
		lineIndex: number,
		sel: { start: SelectionPoint; end: SelectionPoint },
	): { from: number; to: number } | null {
		if (lineIndex < sel.start.line || lineIndex > sel.end.line) return null;
		return {
			from: lineIndex === sel.start.line ? sel.start.col : 0,
			to: lineIndex === sel.end.line ? sel.end.col : Number.MAX_SAFE_INTEGER,
		};
	}

	private highlightSelection(window: string[]): void {
		if (this.selectionMode !== "transcript") return;
		const sel = this.orderedSelection();
		if (!sel) return;
		for (let i = 0; i < window.length; i++) {
			const span = this.selectionSpan(this.scrollTop + i, sel);
			if (!span) continue;
			window[i] = this.highlightLine(window[i], span);
		}
	}

	/** Begin a selection at a screen position; false when outside the transcript window. */
	beginSelection(screenRow: number, screenCol: number): boolean {
		if (screenRow < 0 || screenRow >= this.lastWindowHeight) {
			this.clearSelection();
			return false;
		}
		const point = { line: this.scrollTop + screenRow, col: Math.max(0, screenCol) };
		this.selectionAnchor = point;
		this.selectionHead = { ...point };
		this.selectionMode = "transcript";
		return true;
	}

	extendSelection(screenRow: number, screenCol: number): void {
		if (!this.selectionAnchor || this.selectionMode !== "transcript") return;
		const row = Math.max(0, Math.min(screenRow, this.lastWindowHeight - 1));
		this.selectionHead = { line: this.scrollTop + row, col: Math.max(0, screenCol) };
	}

	/** Finish the selection and return its plain text (null when empty). */
	endSelection(): string | null {
		if (this.selectionMode !== "transcript") {
			this.clearSelection();
			return null;
		}
		const sel = this.orderedSelection();
		this.clearSelection();
		if (!sel) return null;
		return this.extractSelectionText(this.lastTranscript, sel);
	}

	extendActiveSelection(screenRow: number, screenCol: number): void {
		if (this.selectionMode === "frame") {
			this.extendFrameSelection(screenRow, screenCol);
		} else if (this.selectionMode === "transcript") {
			this.extendSelection(screenRow, screenCol);
		}
	}

	endActiveSelection(): string | null {
		if (this.selectionMode === "frame") {
			return this.endFrameSelection();
		}
		if (this.selectionMode === "transcript") {
			return this.endSelection();
		}
		this.clearSelection();
		return null;
	}

	/** Snapshot and highlight the final screen frame for overlay/dock selection. */
	applyFrameSelection(
		frame: string[],
		height: number,
		selectableRegions: ReadonlyArray<{ line: number; col: number; width: number }>,
	): void {
		this.lastFrame = frame;
		this.lastFrameVisibleHeight = Math.min(Math.max(0, height), frame.length);
		this.lastFrameVisibleStart = Math.max(0, frame.length - this.lastFrameVisibleHeight);
		this.frameSelectionRegions = selectableRegions;
		if (this.selectionMode !== "frame") return;
		const sel = this.orderedSelection();
		if (!sel) return;
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			const line = frame[lineIndex];
			if (line === undefined) continue;
			const span = this.selectionSpan(lineIndex, sel);
			if (!span) continue;
			frame[lineIndex] = this.highlightLine(line, span);
		}
	}

	beginFrameSelection(screenRow: number, screenCol: number): boolean {
		const point = this.framePoint(screenRow, screenCol);
		if (!point || !this.isFrameSelectable(point)) {
			this.clearSelection();
			return false;
		}
		this.selectionAnchor = point;
		this.selectionHead = { ...point };
		this.selectionMode = "frame";
		return true;
	}

	extendFrameSelection(screenRow: number, screenCol: number): void {
		if (!this.selectionAnchor || this.selectionMode !== "frame") return;
		const point = this.framePoint(screenRow, screenCol);
		if (!point) return;
		this.selectionHead = point;
	}

	endFrameSelection(): string | null {
		if (this.selectionMode !== "frame") {
			this.clearSelection();
			return null;
		}
		const sel = this.orderedSelection();
		this.clearSelection();
		if (!sel) return null;
		return this.extractSelectionText(this.lastFrame, sel);
	}

	private highlightLine(line: string, span: { from: number; to: number }): string {
		const width = visibleWidth(line);
		const from = Math.min(span.from, width);
		const to = Math.min(span.to, width);
		if (to <= from) return line;
		const before = sliceByColumn(line, 0, from);
		const selected = stripAnsi(sliceByColumn(line, from, to - from));
		const after = sliceByColumn(line, to, Math.max(0, width - to));
		return `${before}\x1b[0m\x1b[7m${selected}\x1b[27m${after}`;
	}

	private framePoint(screenRow: number, screenCol: number): SelectionPoint | null {
		if (this.lastFrameVisibleHeight === 0) return null;
		const row = Math.max(0, Math.min(screenRow, this.lastFrameVisibleHeight - 1));
		const line = this.lastFrameVisibleStart + row;
		if (line < 0 || line >= this.lastFrame.length) return null;
		return { line, col: Math.max(0, screenCol) };
	}

	private isFrameSelectable(point: SelectionPoint): boolean {
		return this.frameSelectionRegions.some(
			(region) => region.line === point.line && point.col >= region.col && point.col < region.col + region.width,
		);
	}

	private extractSelectionText(
		sourceLines: string[],
		sel: { start: SelectionPoint; end: SelectionPoint },
	): string | null {
		const lines: string[] = [];
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			const line = sourceLines[lineIndex] ?? "";
			const span = this.selectionSpan(lineIndex, sel);
			if (!span) continue;
			const width = visibleWidth(line);
			const from = Math.min(span.from, width);
			const to = Math.min(span.to, width);
			lines.push(stripAnsi(sliceByColumn(line, from, Math.max(0, to - from))).trimEnd());
		}
		const text = lines.join("\n");
		return text.trim().length > 0 ? text : null;
	}

	clearSelection(): void {
		this.selectionAnchor = null;
		this.selectionHead = null;
		this.selectionMode = null;
	}

	hasSelection(): boolean {
		return this.orderedSelection() !== null;
	}

	/** Row-diff a composed frame against the previous one with absolute addressing. */
	paint(
		write: (data: string) => void,
		frame: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
	): void {
		// over-tall frames (overlay overflow) show their bottom `height` lines
		if (frame.length > height) {
			frame = frame.slice(frame.length - height);
		}

		let buffer = "\x1b[?2026h";
		if (width !== this.prevWidth || height !== this.prevHeight || this.prevFrame.length === 0) {
			buffer += "\x1b[2J\x1b[H";
			this.prevFrame = [];
		}
		for (let row = 0; row < height; row++) {
			const line = frame[row] ?? "";
			if (this.prevFrame[row] === line) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K`;
			// an overwide line would wrap and shear the grid; clamp instead of crash
			buffer += visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
		}
		if (cursorPos) {
			buffer += `\x1b[${Math.min(cursorPos.row, height - 1) + 1};${cursorPos.col + 1}H`;
		}
		buffer += "\x1b[?2026l";
		write(buffer);

		this.prevFrame = frame;
		this.prevWidth = width;
		this.prevHeight = height;
	}

	/** Force the next paint to clear and repaint the whole screen. */
	reset(): void {
		this.prevFrame = [];
	}

	/** Scrolling up pauses following; reaching the bottom resumes it. */
	scrollBy(delta: number): void {
		const base = this.following ? this.lastMaxScroll : this.scrollTop;
		this.scrollTop = Math.max(0, Math.min(base + delta, this.lastMaxScroll));
		this.following = this.scrollTop >= this.lastMaxScroll;
	}

	scrollToTop(): void {
		this.scrollTop = 0;
		this.following = this.lastMaxScroll === 0;
	}

	scrollToBottom(): void {
		this.scrollTop = this.lastMaxScroll;
		this.following = true;
	}

	pageSize(): number {
		return Math.max(1, this.lastWindowHeight - 1);
	}

	windowHeight(): number {
		return this.lastWindowHeight;
	}

	isFollowing(): boolean {
		return this.following;
	}

	scrollInfo(): ScrollInfo {
		return {
			following: this.following,
			linesBelow: Math.max(0, this.lastMaxScroll - this.scrollTop),
			linesAbove: this.scrollTop,
		};
	}
}

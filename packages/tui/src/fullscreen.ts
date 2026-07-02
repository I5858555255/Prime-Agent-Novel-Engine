/**
 * Fullscreen (alternate-screen) viewport: a scrollable window over the
 * transcript with a dock (editor/footer) pinned to the bottom rows. Frames
 * are a fixed grid painted with absolute addressing and diffed row-by-row;
 * scroll position is application state, not terminal scrollback.
 */

import { isImageLine } from "./terminal-image.js";
import { sliceByColumn, visibleWidth } from "./utils.js";

const MIN_TRANSCRIPT_ROWS = 3;

// Kitty images span multiple physical rows and cannot be clipped to a window.
const IMAGE_PLACEHOLDER = "\x1b[2m[image — view in inline mode]\x1b[0m";

export interface ScrollInfo {
	following: boolean;
	linesBelow: number;
	linesAbove: number;
}

export class FullscreenViewport {
	private scrollTop = 0;
	private following = true;
	private prevFrame: string[] = [];
	private prevWidth = 0;
	private prevHeight = 0;
	private lastMaxScroll = 0;
	private lastWindowHeight = 0;

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

		const window = transcript.slice(this.scrollTop, this.scrollTop + windowHeight);
		for (let i = 0; i < window.length; i++) {
			if (isImageLine(window[i])) window[i] = IMAGE_PLACEHOLDER;
		}
		while (window.length < windowHeight) {
			window.push("");
		}
		return [...window, ...dockLines];
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

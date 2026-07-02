import type { Component, ScrollInfo } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Footer component for the prime brand TUI.
 *
 * Renders nothing by default — token counters, cost, model name, cwd, and context %
 * are intentionally hidden. The setters and invalidate/dispose hooks are kept so the
 * existing call sites in interactive-mode keep working without modification, and so
 * `/usage` can expose telemetry without re-plumbing.
 */
export class FooterComponent implements Component {
	// Supplies fullscreen scroll state; null/undefined when not in fullscreen.
	private scrollInfoProvider?: () => ScrollInfo | null;
	private followKeyDisplay = "ctrl+end";

	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	setScrollInfoProvider(provider: () => ScrollInfo | null, followKeyDisplay?: string): void {
		this.scrollInfoProvider = provider;
		if (followKeyDisplay) this.followKeyDisplay = followKeyDisplay;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op while the footer is empty
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		// While the fullscreen transcript is scrolled up, show how far behind the
		// live output the window is and how to resume following.
		const scrollInfo = this.scrollInfoProvider?.();
		if (scrollInfo && !scrollInfo.following) {
			const line = ` ${scrollInfo.linesBelow} line${scrollInfo.linesBelow === 1 ? "" : "s"} below · ${this.followKeyDisplay} to follow`;
			return [truncateToWidth(theme.fg("dim", line), width)];
		}
		// Footer is otherwise intentionally empty in the prime brand TUI. Telemetry (cost,
		// tokens, model, cwd, context %) is hidden by default; bring it back via /usage when needed.
		return [];
	}
}

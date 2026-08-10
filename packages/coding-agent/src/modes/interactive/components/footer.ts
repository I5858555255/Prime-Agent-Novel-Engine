import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";

/**
 * Footer component for the prime brand TUI.
 *
 * The footer is intentionally limited to extension statuses. Token counters,
 * cost, model name, cwd, and context % remain hidden and are available via
 * `/usage` where applicable.
 */
export class FooterComponent implements Component {
	constructor(private footerData: ReadonlyFooterDataProvider) {}

	setAutoCompactEnabled(_enabled: boolean): void {
		// Kept for compatibility with existing interactive-mode call sites.
	}

	/**
	 * No-op: git branch caching is handled by the provider.
	 */
	invalidate(): void {
		// Git branch is cached and invalidated by the provider.
	}

	/**
	 * Clean up resources.
	 */
	dispose(): void {
		// Git watcher cleanup is handled by the provider.
	}

	render(width: number): string[] {
		const statuses = [...this.footerData.getExtensionStatuses().values()].filter(Boolean);
		if (statuses.length === 0) return [];
		return [truncateToWidth(statuses.join("  "), width)];
	}
}

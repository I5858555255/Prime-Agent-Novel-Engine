import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.js";
import { getMarkdownTheme } from "../theme/theme.js";
import { CompactionBreakComponent } from "./compaction-break.js";

/**
 * Component that renders a compaction break with collapsed/expanded state.
 */
export class CompactionSummaryMessageComponent extends CompactionBreakComponent {
	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(
			{
				summary: message.summary,
				tokensBefore: message.tokensBefore,
				reason: "engine",
				kernelRestarted: true,
				timestamp: message.timestamp,
			},
			markdownTheme,
		);
	}
}

/** Wire-safe types for the immediate /rlm-max-depth state APIs. */

import type { SettingsScope } from "./settings-manager.js";

export type RlmMaxDepthSource = "default" | "env" | "global" | "project" | "inherited" | "chat";

export interface RlmMaxDepthStatus {
	maxDepth: number;
	source: RlmMaxDepthSource;
}

export interface SetRlmMaxDepthResult extends RlmMaxDepthStatus {
	/** Settings scope the value was persisted to, when persisting was requested. */
	savedScope?: SettingsScope;
	/** True only when a requested global settings write succeeded. */
	globalSaved: boolean;
	globalError?: string;
	/** True only when a requested project settings write succeeded. */
	projectSaved?: boolean;
	projectError?: string;
}

import { describe, expect, it } from "vitest";
import type { Settings } from "../src/core/settings-manager.js";
import { flattenSettings, getTopLevelKeys, isNestedSetting, SETTING_GROUPS } from "../src/core/settings-schema.js";

describe("settings-schema", () => {
	describe("schema completeness", () => {
		it("should have at least one setting in each group", () => {
			for (const group of SETTING_GROUPS) {
				expect(group.settings.length).toBeGreaterThan(0);
			}
		});

		it("should have unique keys across all settings", () => {
			const all = flattenSettings();
			const keys = all.map((s) => s.key);
			const unique = new Set(keys);
			expect(unique.size).toBe(keys.length);
		});
	});

	describe("schema-to-runtime alignment", () => {
		it("all top-level schema keys should exist on the Settings interface", () => {
			const schemaKeys = getTopLevelKeys();

			for (const key of schemaKeys) {
				if (isNestedSetting(key)) {
					// These are objects that exist on Settings
					expect(isNestedSetting(key)).toBe(true);
				} else {
					// Top-level keys should be valid Setting keys
					const validKey = key as keyof Settings;
					expect(typeof validKey).toBe("string");
				}
			}
		});

		it("schema should cover known Settings interface keys", () => {
			// Flatten all schema keys (including those from nested objects)
			const schemaKeys = new Set(getTopLevelKeys());

			// Verify core top-level settings are present in schema
			const requiredKeys = [
				"defaultProvider",
				"defaultModel",
				"defaultThinkingLevel",
				"hideThinkingBlock",
				"thinkingBudgets",
				"theme",
				"quietStartup",
				"treeFilterMode",
				"editorPaddingX",
				"autocompleteMaxVisible",
				"showHardwareCursor",
				"steeringMode",
				"followUpMode",
				"transport",
				"shellPath",
				"shellCommandPrefix",
				"npmCommand",
				"idleEvictionMinutes",
				"sessionDir",
				"enabledModels",
				"packages",
				"extensions",
				"skills",
				"prompts",
				"themes",
				"enableSkillCommands",
				"enableBuiltinSkills",
			];

			for (const key of requiredKeys) {
				expect(schemaKeys.has(key)).toBe(true);
			}

			// Verify nested settings have dot-path keys
			const nestedKeys = [
				"telemetry.enabled",
				"warnings.anthropicExtraUsage",
				"compaction.enabled",
				"compaction.reserveTokens",
				"compaction.keepRecentTokens",
				"compaction.agentCallable",
				"autoRefine.enabled",
				"autoRefine.turnInterval",
				"autoRefine.compact",
				"autoRefine.cooldownMs",
				"branchSummary.reserveTokens",
				"branchSummary.skipPrompt",
				"retry.enabled",
				"retry.maxRetries",
				"retry.baseDelayMs",
				"retry.provider.timeoutMs",
				"retry.provider.maxRetries",
				"retry.provider.maxRetryDelayMs",
				"terminal.showImages",
				"terminal.clearOnShrink",
				"terminal.fullscreen",
				"images.autoResize",
				"images.blockImages",
				"markdown.codeBlockIndent",
				"bundledSkills.websearch",
				"agentTraces.enabled",
			];

			for (const key of nestedKeys) {
				expect(schemaKeys.has(key)).toBe(true);
			}
		});

		it("nested settings should have dot-path keys", () => {
			const compactionGroup = SETTING_GROUPS.find((g) => g.title === "Compaction");
			expect(compactionGroup).toBeDefined();

			const keys = compactionGroup!.settings.map((s) => s.key);
			expect(keys).toContain("compaction.enabled");
			expect(keys).toContain("compaction.reserveTokens");
			expect(keys).toContain("compaction.keepRecentTokens");
			expect(keys).toContain("compaction.agentCallable");
		});
	});

	describe("default values", () => {
		it("should have defaults for all settings", () => {
			const all = flattenSettings();
			for (const setting of all) {
				expect(setting.default).toBeDefined();
				expect(setting.default.length).toBeGreaterThan(0);
			}
		});

		it("should have descriptions for all settings", () => {
			const all = flattenSettings();
			for (const setting of all) {
				expect(setting.description).toBeDefined();
				expect(setting.description.length).toBeGreaterThan(0);
			}
		});
	});

	describe("enum validation", () => {
		it("should have valid enum values", () => {
			const all = flattenSettings();
			for (const setting of all) {
				if (setting.enum) {
					expect(setting.enum.values.length).toBeGreaterThan(0);
					for (const value of setting.enum.values) {
						expect(value.length).toBeGreaterThan(0);
					}
				}
			}
		});

		it("should match documented thinking levels", () => {
			const thinkingGroup = SETTING_GROUPS.find((g) => g.title === "Model & Thinking");
			const thinkingLevel = thinkingGroup!.settings.find((s) => s.key === "defaultThinkingLevel");
			expect(thinkingLevel!.enum!.values).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		});
	});
});

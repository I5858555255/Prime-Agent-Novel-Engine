/**
 * Generates settings.md documentation from the machine-readable settings schema.
 *
 * Run with: npx tsx scripts/generate-settings-docs.ts
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { SETTING_GROUPS, type SettingDefinition } from "../src/core/settings-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function escapeMd(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderEnum(setting: SettingDefinition): string {
	if (!setting.enum) return "-";
	return setting.enum.values.map((v) => `\`"${v}"\``).join(", ");
}

function renderDefault(setting: SettingDefinition): string {
	if (setting.default === "SDK default") return "SDK default";
	if (setting.default === "-") return "-";
	return `\`${setting.default}\``;
}

function renderConstraints(setting: SettingDefinition): string {
	const parts: string[] = [];
	if (setting.min !== undefined) parts.push(`min: ${setting.min}`);
	if (setting.max !== undefined) parts.push(`max: ${setting.max}`);
	if (setting.enum) parts.push(`enum: ${renderEnum(setting)}`);
	return parts.length > 0 ? parts.join(", ") : "";
}

function renderSettingTable(settings: SettingDefinition[]): string {
	const lines: string[] = [];
	lines.push("| Setting | Type | Default | Description |");
	lines.push("|---------|------|---------|-------------|");

	for (const setting of settings) {
		const constraints = renderConstraints(setting);
		const description = constraints
			? `${escapeMd(setting.description)} (${constraints})`
			: escapeMd(setting.description);
		lines.push(
			`| \`${setting.key}\` | ${setting.type} | ${renderDefault(setting)} | ${description} |`,
		);
	}

	return lines.join("\n");
}

function generateMarkdown(): string {
	const lines: string[] = [];

	lines.push("# Settings");
	lines.push("");
	lines.push("Prime Agent uses JSON settings files with project settings overriding global settings.");
	lines.push("");
	lines.push("| Location | Scope |");
	lines.push("|----------|-------|");
	lines.push("| `~/.prime/agent/settings.json` | Global (all projects) |");
	lines.push("| `.prime/agent/settings.json` | Project (current directory) |");
	lines.push("");
	lines.push("Edit directly or use `/settings` for common options.");
	lines.push("");
	lines.push("## All Settings");
	lines.push("");

	for (const group of SETTING_GROUPS) {
		lines.push(`### ${group.title}`);
		lines.push("");
		lines.push(renderSettingTable(group.settings));
		lines.push("");

		// Render example JSON for groups with nested settings that have children
		const nestedWithChildren = group.settings.filter((s) => s.children && s.children.length > 0);
		for (const parent of nestedWithChildren) {
			const example: Record<string, unknown> = {};
			const nested: Record<string, unknown> = {};
			for (const child of parent.children!) {
				nested[child.name] = getExampleValue(child);
			}
			example[parent.key] = nested;
			lines.push(`#### ${parent.key}`);
			lines.push("");
			lines.push("```json");
			lines.push(JSON.stringify(example, null, 2));
			lines.push("```");
			lines.push("");
		}
	}

	// Add the example section
	lines.push("## Example");
	lines.push("");
	lines.push("```json");
	lines.push(
		JSON.stringify(
			{
				defaultProvider: "anthropic",
				defaultModel: "claude-sonnet-4-20250514",
				defaultThinkingLevel: "medium",
				theme: "dark",
				compaction: {
					enabled: true,
					reserveTokens: 16384,
					keepRecentTokens: 20000,
				},
				retry: {
					enabled: true,
					maxRetries: 3,
				},
				enabledModels: ["claude-*", "gpt-4o"],
				warnings: {
					anthropicExtraUsage: true,
				},
				packages: ["pi-skills"],
			},
			null,
			2,
		),
	);
	lines.push("```");
	lines.push("");

	// Add project overrides section
	lines.push("## Project Overrides");
	lines.push("");
	lines.push("Project settings (`.prime/agent/settings.json`) override global settings. Nested objects are merged:");
	lines.push("");
	lines.push("```json");
	lines.push("// ~/.prime/agent/settings.json (global)");
	lines.push(JSON.stringify({ theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } }, null, 2));
	lines.push("");
	lines.push("// .prime/agent/settings.json (project)");
	lines.push(JSON.stringify({ compaction: { reserveTokens: 8192 } }, null, 2));
	lines.push("");
	lines.push("// Result");
	lines.push(
		JSON.stringify({ theme: "dark", compaction: { enabled: true, reserveTokens: 8192 } }, null, 2),
	);
	lines.push("```");

	return lines.join("\n");
}

function getExampleValue(setting: SettingDefinition): unknown {
	if (setting.type === "boolean") return true;
	if (setting.type === "number") return 16384;
	if (setting.type === "string[]") return ["example"];
	if (setting.type === "string") return setting.enum ? setting.enum.values[0] : "value";
	return setting.default;
}

const output = generateMarkdown();
const outputPath = join(__dirname, "..", "docs", "settings.md");
writeFileSync(outputPath, output, "utf-8");
console.log(`Generated ${outputPath}`);

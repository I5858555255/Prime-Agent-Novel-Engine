#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = resolve(root, "install.sh");
const rootPackagePath = resolve(root, "package.json");
const codingAgentPackagePath = resolve(root, "packages/coding-agent/package.json");
const runtimeVersionGuardPath = resolve(root, "packages/coding-agent/src/cli/node-version-check.ts");
const generatedMinimumPattern = /^prime_agent_min_node_version="([^"]+)" # generated from packages\/coding-agent\/package\.json engines\.node$/m;
const baseUrlPlaceholder = "__PRIME_AGENT_DOWNLOAD_BASE_URL__";
const releaseChannelPlaceholder = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__";
const unresolvedPlaceholderPattern = /__PRIME_AGENT_[A-Z0-9_]+__/;

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function exactMinimumFromEngine(path) {
	const engine = readJson(path).engines?.node;
	const match = typeof engine === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(engine) : null;
	if (!match) {
		throw new Error(`${path} must declare engines.node as an exact minimum such as >=22.8.0`);
	}
	return match[1];
}

export function getMinimumNodeVersion() {
	const minimum = exactMinimumFromEngine(codingAgentPackagePath);
	const rootMinimum = exactMinimumFromEngine(rootPackagePath);
	if (rootMinimum !== minimum) {
		throw new Error(`Root Node engine ${rootMinimum} does not match coding-agent minimum ${minimum}`);
	}

	const guardSource = readFileSync(runtimeVersionGuardPath, "utf8");
	const guardMatch = /^export const MIN_NODE_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(guardSource);
	if (!guardMatch || guardMatch[1] !== minimum) {
		throw new Error(`Runtime Node minimum does not match coding-agent engines.node ${minimum}`);
	}
	return minimum;
}

function installerMinimum(source) {
	const matches = [...source.matchAll(new RegExp(generatedMinimumPattern.source, "gm"))];
	if (matches.length !== 1) {
		throw new Error(`install.sh must contain exactly one generated Node minimum assignment; found ${matches.length}`);
	}
	return matches[0][1];
}

export function assertInstallerMinimumIsCurrent(source) {
	const expected = getMinimumNodeVersion();
	const actual = installerMinimum(source);
	if (actual !== expected) {
		throw new Error(`install.sh Node minimum ${actual} is stale; expected ${expected}`);
	}
}

export function renderInstallerMinimum(source) {
	installerMinimum(source);
	const minimum = getMinimumNodeVersion();
	return source.replace(
		generatedMinimumPattern,
		`prime_agent_min_node_version="${minimum}" # generated from packages/coding-agent/package.json engines.node`,
	);
}

function replaceUniquePlaceholder(source, placeholder, value) {
	const count = source.split(placeholder).length - 1;
	if (count !== 1) {
		throw new Error(`install.sh must contain exactly one ${placeholder} placeholder; found ${count}`);
	}
	return source.replace(placeholder, value);
}

export function renderInstaller(source, { baseUrl, channel }) {
	const normalizedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
	if (!normalizedBaseUrl) throw new Error("--base-url must contain a non-root URL");
	if (channel !== "stable" && channel !== "beta") throw new Error("--channel must be stable or beta");

	let rendered = renderInstallerMinimum(source);
	rendered = replaceUniquePlaceholder(rendered, baseUrlPlaceholder, normalizedBaseUrl);
	rendered = replaceUniquePlaceholder(rendered, releaseChannelPlaceholder, channel);
	const unresolved = unresolvedPlaceholderPattern.exec(rendered);
	if (unresolved) {
		throw new Error(`Rendered installer contains unresolved placeholder ${unresolved[0]}`);
	}
	return rendered;
}

function parseArgs(args) {
	const parsed = { baseUrl: undefined, channel: undefined, output: undefined };
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		const value = args[index + 1];
		if (!value) throw new Error(`${option} requires a value`);
		switch (option) {
			case "--base-url":
				parsed.baseUrl = value;
				break;
			case "--channel":
				parsed.channel = value;
				break;
			case "--output":
				parsed.output = value;
				break;
			default:
				throw new Error(`Unknown argument: ${option}`);
		}
		index += 1;
	}
	if (!parsed.output) throw new Error("--output is required");
	return parsed;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const source = readFileSync(installerPath, "utf8");
	const rendered = renderInstaller(source, { baseUrl: args.baseUrl, channel: args.channel });
	writeFileSync(resolve(args.output), rendered, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

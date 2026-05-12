import { ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, ENV_VERSION_CHECK_URL } from "../config.js";
import { getPrimeAgentUserAgent } from "./prime-agent-user-agent.js";

const DEFAULT_LATEST_VERSION_URL = "https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPrimeAgentRelease {
	version: string;
	packageName?: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPrimeAgentRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPrimeAgentRelease | undefined> {
	if (process.env[ENV_SKIP_VERSION_CHECK] || process.env[ENV_OFFLINE]) return undefined;
	const latestVersionUrl = process.env[ENV_VERSION_CHECK_URL] || DEFAULT_LATEST_VERSION_URL;

	const response = await fetch(latestVersionUrl, {
		headers: {
			"User-Agent": getPrimeAgentUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		name?: unknown;
		packageName?: unknown;
		tag_name?: unknown;
		version?: unknown;
	};
	const version =
		typeof data.version === "string"
			? data.version
			: typeof data.tag_name === "string"
				? data.tag_name
				: typeof data.name === "string"
					? data.name
					: undefined;
	if (typeof version !== "string" || !version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	return { version: version.trim(), packageName };
}

export async function getLatestPrimeAgentVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPrimeAgentRelease(currentVersion, options))?.version;
}

export async function checkForNewPrimeAgentVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestPrimeAgentVersion(currentVersion);
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

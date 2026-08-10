// Dependency-free and Node-20-safe so it can never crash on the versions it rejects.

export const MIN_NODE_VERSION = "22.8.0";
const MIN_NODE_VERSION_PARTS = parseMinimumNodeVersion(MIN_NODE_VERSION);

export interface NodeVersionGuardIO {
	version: string;
	log: (message: string) => void;
	exit: (code: number) => void;
}

interface ParsedNodeVersion {
	parts: readonly [number, number, number];
	prerelease: boolean;
}

function parseMinimumNodeVersion(version: string): readonly [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`Invalid minimum Node version: ${version}`);
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseVersion(version: string): ParsedNodeVersion | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) {
		return undefined;
	}

	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] !== undefined,
	};
}

function isSupportedNodeVersion(version: ParsedNodeVersion): boolean {
	if (version.prerelease) {
		return false;
	}
	for (let index = 0; index < MIN_NODE_VERSION_PARTS.length; index++) {
		const part = version.parts[index]!;
		const minimumPart = MIN_NODE_VERSION_PARTS[index]!;
		if (part !== minimumPart) {
			return part > minimumPart;
		}
	}
	return true;
}

export function assertNodeVersion(io: NodeVersionGuardIO): boolean {
	// Bun ships its own runtime; its node-compat version is unrelated to the user's Node.
	if (process.versions.bun) {
		return true;
	}

	const version = parseVersion(io.version);
	if (!version || isSupportedNodeVersion(version)) {
		return true;
	}

	io.log(`prime-agent requires Node ${MIN_NODE_VERSION} or newer, but the active Node is v${io.version}.`);
	io.log("");
	io.log(
		`  1. Install Node ${MIN_NODE_VERSION}+ (e.g. "nvm install ${MIN_NODE_VERSION_PARTS[0]} && nvm use ${MIN_NODE_VERSION_PARTS[0]}", or from https://nodejs.org)`,
	);
	io.log("  2. Reinstall prime-agent under that Node so the command resolves to it:");
	io.log("     https://github.com/PrimeIntellect-ai/prime-agent/releases/latest");
	io.exit(1);
	return false;
}

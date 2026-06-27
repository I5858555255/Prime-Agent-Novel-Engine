// Dependency-free and Node-20-safe so it can never crash on the versions it rejects.

export const MIN_NODE_MAJOR = 22;

export interface NodeVersionGuardIO {
	version: string;
	log: (message: string) => void;
	exit: (code: number) => void;
}

function parseMajor(version: string): number {
	return parseInt(version.split(".")[0]!.replace(/^v/, ""), 10);
}

export function assertNodeVersion(io: NodeVersionGuardIO): boolean {
	// Bun ships its own runtime; its node-compat version is unrelated to the user's Node.
	if (process.versions.bun) {
		return true;
	}

	const major = parseMajor(io.version);
	if (Number.isNaN(major) || major >= MIN_NODE_MAJOR) {
		return true;
	}

	io.log(`prime-agent requires Node ${MIN_NODE_MAJOR} or newer, but the active Node is v${io.version}.`);
	io.log("");
	io.log(`  1. Install Node ${MIN_NODE_MAJOR}+ (e.g. "nvm install 22 && nvm use 22", or from https://nodejs.org)`);
	io.log("  2. Reinstall prime-agent under that Node so the command resolves to it:");
	io.log("     https://github.com/PrimeIntellect-ai/prime-agent/releases/latest");
	io.exit(1);
	return false;
}

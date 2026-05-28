import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-${process.pid}`;
	}
	return join(tmpdir(), "prime-agent-daemon.sock");
}

export async function prepareDaemonSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32" || !existsSync(socketPath)) {
		return;
	}

	const stat = lstatSync(socketPath);
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}

	unlinkSync(socketPath);
}

export function cleanupDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	}
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

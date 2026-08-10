import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDaemonWorkerSocketDir } from "../src/modes/daemon/daemon-socket.js";
import { workerSocketPath } from "../src/modes/daemon/daemon-supervisor.js";

describe.runIf(process.platform !== "win32")("Unix daemon worker socket paths", () => {
	it("uses a fixed short per-user directory within the Unix socket path limit", () => {
		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = workerSocketPath(
			"/var/folders/aa/0123456789012345678901234567/T/prime-agent-4294967295/daemon.sock",
			"01234567-89ab-cdef-0123-456789abcdef",
		);

		expect(defaultDaemonWorkerSocketDir()).toBe(join("/tmp", `prime-agent-${suffix}`));
		expect(dirname(socketPath)).toBe(defaultDaemonWorkerSocketDir());
		expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(100);
		expect(Buffer.byteLength(join("/tmp", "prime-agent-4294967295", basename(socketPath)))).toBeLessThanOrEqual(100);
	});
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDaemonSocketDir } from "../../../src/modes/daemon/daemon-socket.js";

const LONGEST_SOCKET_NAME_LENGTH = "worker-0123456789ab-0123456789ab.sock".length;
const BSD_SUN_PATH_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "freebsd", "openbsd", "netbsd"]);
const UNIX_SOCKET_PATH_LIMIT = BSD_SUN_PATH_PLATFORMS.has(process.platform) ? 103 : 107;

// The fallback under test is Unix-only: Windows named pipes have no sun_path
// limit and defaultDaemonSocketDir never rewrites the directory there.
describe.skipIf(process.platform === "win32")("issue #669 worker socket path must fit the sun_path limit", () => {
	const originalTmpdir = process.env.TMPDIR;

	afterEach(() => {
		if (originalTmpdir === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = originalTmpdir;
		}
	});

	it("falls back to /tmp when the tmpdir-based path would exceed the limit", () => {
		// Simulate the reported shape: a long macOS /var/folders tmpdir plus a
		// 10-digit uid. 80 chars of tmpdir guarantees overflow for any uid.
		process.env.TMPDIR = join("/private/var/folders", "a".repeat(60));
		const dir = defaultDaemonSocketDir();
		expect(dir.startsWith("/tmp/prime-agent-")).toBe(true);
		expect(dir.length + 1 + LONGEST_SOCKET_NAME_LENGTH).toBeLessThanOrEqual(UNIX_SOCKET_PATH_LIMIT);
	});

	it("keeps using the OS tmpdir when the path fits", () => {
		process.env.TMPDIR = "/tmp";
		const dir = defaultDaemonSocketDir();
		expect(dir.startsWith(join(tmpdir(), "prime-agent-"))).toBe(true);
	});

	it("always yields a directory whose worker sockets fit the platform limit", () => {
		for (const candidate of ["/tmp", join("/private/var/folders", "b".repeat(70))]) {
			process.env.TMPDIR = candidate;
			const dir = defaultDaemonSocketDir();
			expect(dir.length + 1 + LONGEST_SOCKET_NAME_LENGTH).toBeLessThanOrEqual(UNIX_SOCKET_PATH_LIMIT);
		}
	});
});

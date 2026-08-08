import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removePath, removePathSync } from "../../src/utils/durable-fs.js";

/**
 * Scratch-tree teardown uses the product's own remove helpers, which retry the
 * Windows race where a just-exited child (kernel, daemon, worker) still holds a
 * handle inside the directory being deleted.
 *
 * On Windows the retries can still lose: a kernel under a fully parallel suite
 * run may take longer to release its working directory than any budget worth
 * blocking teardown for. The tree lives under the OS temp directory, which the
 * OS reclaims, so the failure is reported and swallowed rather than turned into
 * a test failure that says nothing about the code under test.
 */
const WINDOWS_TEARDOWN_ATTEMPTS = 10;

function reportAbandonedTempDir(path: string, error: unknown): void {
	console.warn(`Could not remove scratch directory (leaving it for the OS): ${path}: ${String(error)}`);
}

export function removeTempDirSync(path: string): void {
	const attempts = process.platform === "win32" ? WINDOWS_TEARDOWN_ATTEMPTS : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			removePathSync(path);
			return;
		} catch (error) {
			if (attempt < attempts) continue;
			if (process.platform !== "win32") throw error;
			reportAbandonedTempDir(path, error);
			return;
		}
	}
}

export async function removeTempDir(path: string): Promise<void> {
	// Preferred in async teardown: unlike the sync form it yields between
	// attempts instead of blocking the thread, which is what lets pending handle
	// closes actually complete.
	const attempts = process.platform === "win32" ? WINDOWS_TEARDOWN_ATTEMPTS : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			await removePath(path);
			return;
		} catch (error) {
			if (attempt < attempts) continue;
			if (process.platform !== "win32") throw error;
			reportAbandonedTempDir(path, error);
			return;
		}
	}
}

/**
 * Create a directory symlink that also works for unprivileged Windows users.
 *
 * Symlinks need SeCreateSymbolicLinkPrivilege there, but junctions do not and
 * behave the same for directory traversal. Junction targets must be absolute.
 */
export function symlinkDirSync(target: string, linkPath: string): void {
	if (process.platform === "win32") {
		symlinkSync(resolve(dirname(linkPath), target), linkPath, "junction");
		return;
	}
	symlinkSync(target, linkPath);
}

/**
 * True when this host can create *file* symlinks, which have no junction
 * equivalent and stay privileged on Windows without Developer Mode.
 */
export function canCreateFileSymlinks(): boolean {
	const probeDir = mkdtempSync(join(tmpdir(), "pi-symlink-probe-"));
	try {
		writeFileSync(join(probeDir, "target.txt"), "probe");
		symlinkSync("target.txt", join(probeDir, "link.txt"));
		return true;
	} catch {
		return false;
	} finally {
		removeTempDirSync(probeDir);
	}
}

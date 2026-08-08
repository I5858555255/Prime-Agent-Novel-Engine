import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removePath, removePathSync } from "../../src/utils/durable-fs.js";

/**
 * Scratch-tree teardown uses the product's own remove helpers, which retry the
 * Windows race where a just-exited child (kernel, daemon, worker) still holds a
 * handle inside the directory being deleted.
 */
export function removeTempDirSync(path: string): void {
	// Teardown can outlive a kernel or worker shutdown by longer than the
	// product's own retry budget, and a scratch tree left behind fails the next
	// run rather than the current one. Retry the whole thing a few more times.
	const attempts = process.platform === "win32" ? 5 : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			removePathSync(path);
			return;
		} catch (error) {
			if (attempt >= attempts) throw error;
		}
	}
}

export async function removeTempDir(path: string): Promise<void> {
	// Preferred in async teardown: unlike the sync form it yields between
	// attempts instead of blocking the thread, which is what lets pending handle
	// closes actually complete.
	const attempts = process.platform === "win32" ? 10 : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			await removePath(path);
			return;
		} catch (error) {
			if (attempt >= attempts) throw error;
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

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Windows will not unlink a file while any handle to it is open, and handles
 * held by a just-exited child (kernel, daemon, worker) are released a few
 * milliseconds after the process itself is gone. Test teardown therefore races
 * the OS. Node implements the retry loop for exactly this case — it is only
 * opt-in — so scratch-tree cleanup goes through these helpers instead of a bare
 * `rmSync`.
 */
const REMOVE_OPTIONS =
	process.platform === "win32"
		? ({ recursive: true, force: true, maxRetries: 20, retryDelay: 50 } as const)
		: ({ recursive: true, force: true } as const);

export function removeTempDirSync(path: string): void {
	rmSync(path, REMOVE_OPTIONS);
}

export async function removeTempDir(path: string): Promise<void> {
	await rm(path, REMOVE_OPTIONS);
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

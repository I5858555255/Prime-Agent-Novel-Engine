/**
 * Capability probes for tests whose fixtures need something the host OS may not
 * provide. Prefer these over a `process.platform` check: they describe what the
 * test actually needs, and they keep the test running wherever the capability
 * happens to exist (unprivileged Windows cannot create symlinks, but an
 * elevated shell and the GitHub Actions Windows runners can).
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probeSymlinkSupport(): boolean {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), "pi-symlink-probe-"));
		const target = join(dir, "target");
		writeFileSync(target, "");
		symlinkSync(target, join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/** False on Windows without Developer Mode or an elevated shell. */
export const SYMLINKS_SUPPORTED = probeSymlinkSupport();

/**
 * POSIX permission bits are advisory on Windows: chmod() succeeds but does not
 * make a directory read-only, so tests that revoke write access to assert a
 * fallback cannot express their precondition there.
 */
export const POSIX_PERMISSIONS_ENFORCED = process.platform !== "win32";

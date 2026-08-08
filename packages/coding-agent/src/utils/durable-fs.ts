import { closeSync, fsyncSync, openSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Windows refuses to unlink a file while any handle to it is open, and a handle
 * can outlive the process that owned it by a few milliseconds. Node's own retry
 * loop covers exactly that race (EBUSY/EPERM/ENOTEMPTY), but only when asked.
 */
const WINDOWS_REMOVE_RETRIES = { maxRetries: 10, retryDelay: 50 } as const;

function removeOptions(): { recursive: true; force: true; maxRetries?: number; retryDelay?: number } {
	return process.platform === "win32"
		? { recursive: true, force: true, ...WINDOWS_REMOVE_RETRIES }
		: { recursive: true, force: true };
}

/** Recursively delete a path, tolerating Windows' briefly-held file handles. */
export function removePathSync(path: string): void {
	rmSync(path, removeOptions());
}

/** Async counterpart of {@link removePathSync}. */
export async function removePath(path: string): Promise<void> {
	await rm(path, removeOptions());
}

/**
 * Flush a directory entry so a preceding atomic rename survives a crash.
 *
 * This is the POSIX idiom: after `rename()`, the new name only becomes durable
 * once the parent directory itself is fsynced. Windows has no equivalent —
 * opening a directory handle for fsync fails with EPERM — but NTFS journals
 * directory metadata as part of the rename, so skipping the call there loses no
 * durability. Other platforms can also refuse the call on exotic filesystems,
 * so failures are swallowed rather than propagated: the rename already
 * guarantees readers never observe a torn file.
 */
export function syncDirectory(directory: string): void {
	if (process.platform === "win32") {
		return;
	}
	try {
		const descriptor = openSync(directory, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Directory fsync is unavailable on some filesystems; the atomic rename
		// still protects readers.
	}
}

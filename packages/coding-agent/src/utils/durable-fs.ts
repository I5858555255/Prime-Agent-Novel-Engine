import { closeSync, existsSync, fsyncSync, openSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Windows refuses to unlink a file, or its containing directory, while any
 * handle to it is open — and the handles a just-exited child held are released
 * shortly *after* its `exit` event, so a correct delete can still lose the race
 * by a few milliseconds.
 *
 * `rmSync`'s own `maxRetries` does not cover this: the native implementation
 * surfaces the directory-level EPERM without retrying, so the loop lives here.
 */
const WINDOWS_REMOVE_ATTEMPTS = 20;
const WINDOWS_REMOVE_DELAY_MS = 50;
const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EMFILE", "ENFILE"]);

const REMOVE_OPTIONS = { recursive: true, force: true } as const;

function isRetryableRemoveError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code !== undefined && RETRYABLE_REMOVE_CODES.has(code);
}

/** Block the calling thread; only used to space out sync delete retries. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Recursively delete a path, tolerating Windows' briefly-held file handles. */
export function removePathSync(path: string): void {
	if (process.platform !== "win32") {
		rmSync(path, REMOVE_OPTIONS);
		return;
	}
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(path, REMOVE_OPTIONS);
			return;
		} catch (error) {
			if (attempt >= WINDOWS_REMOVE_ATTEMPTS || !isRetryableRemoveError(error)) throw error;
			sleepSync(WINDOWS_REMOVE_DELAY_MS);
		}
	}
}

/** Async counterpart of {@link removePathSync}. */
export async function removePath(path: string): Promise<void> {
	if (process.platform !== "win32") {
		await rm(path, REMOVE_OPTIONS);
		return;
	}
	for (let attempt = 1; ; attempt++) {
		try {
			await rm(path, REMOVE_OPTIONS);
			return;
		} catch (error) {
			if (attempt >= WINDOWS_REMOVE_ATTEMPTS || !isRetryableRemoveError(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, WINDOWS_REMOVE_DELAY_MS));
		}
	}
}

/**
 * True when a failed `rename(candidateDir, targetDir)` means the target was
 * already claimed rather than something being wrong with the rename.
 *
 * Directory-onto-directory rename is the portable way to claim a lock
 * atomically. Unix reports the loser with EEXIST or ENOTEMPTY; Windows reports
 * EPERM or EACCES, which is indistinguishable from a genuine permission failure
 * except by checking whether the target now exists.
 */
export function isDirectoryClaimConflict(error: unknown, directory: string): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EEXIST" || code === "ENOTEMPTY") {
		return true;
	}
	return (code === "EPERM" || code === "EACCES") && existsSync(directory);
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

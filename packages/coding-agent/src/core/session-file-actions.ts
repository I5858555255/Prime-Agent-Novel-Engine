import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import { manifestPathFor, snapshotPathFor } from "./kernel/state-snapshot.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

/** Best-effort removal of a session's kernel snapshot payload + manifest. */
async function deleteKernelStateFor(sessionPath: string): Promise<void> {
	const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	if (!sessionId) return;
	await Promise.allSettled([unlink(snapshotPathFor(sessionId)), unlink(manifestPathFor(sessionId))]);
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also removes the session's kernel state snapshot, which is derived data.
 */
export async function deleteSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	await deleteKernelStateFor(sessionPath);
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

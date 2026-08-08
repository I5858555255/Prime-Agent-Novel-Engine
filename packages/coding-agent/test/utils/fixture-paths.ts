import { resolve } from "node:path";

/**
 * Turn a POSIX-looking fixture path into the absolute path this platform will
 * actually produce.
 *
 * `/tmp/sessions/a.jsonl` is absolute on Windows too, so it passes `isAbsolute`
 * checks unchanged — but the moment the product canonicalizes it, it becomes
 * `C:\tmp\sessions\a.jsonl`. Fixtures and expectations both go through here so
 * they agree with whatever the product computes.
 */
export function absolutePathFixture(posixPath: string): string {
	return resolve(posixPath);
}

/** The `file:`-prefixed session identity the product derives from a path. */
export function fileIdentityFixture(posixPath: string): string {
	return `file:${absolutePathFixture(posixPath)}`;
}

import { DAEMON_CLIENT_ENV_KEYS } from "./daemon-protocol.js";

/** Re-filter client-sent env to the allowlist; the socket peer is untrusted. */
export function filterClientEnv(env?: Record<string, string>): Record<string, string> | undefined {
	if (!env) {
		return undefined;
	}
	const filtered: Record<string, string> = {};
	for (const key of DAEMON_CLIENT_ENV_KEYS) {
		if (env[key] !== undefined) {
			filtered[key] = env[key];
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

// Serializes env windows so overlapping creates can't cross-restore each
// other's values. Only env-carrying operations queue here.
let envWindow: Promise<unknown> = Promise.resolve();

/**
 * Run fn with the client's env applied to process.env, restoring afterwards.
 * Extensions capture vars like HERDR_PANE_ID synchronously at module load, so
 * they must be in process.env while the session loads its extensions; after
 * this window the session's exec env covers subprocess reads.
 */
export async function withClientEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
	if (!env) {
		return fn();
	}
	const run = envWindow.then(async () => {
		const previous = new Map<string, string | undefined>();
		for (const [key, value] of Object.entries(env)) {
			previous.set(key, process.env[key]);
			process.env[key] = value;
		}
		try {
			return await fn();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});
	envWindow = run.catch(() => undefined);
	return run;
}

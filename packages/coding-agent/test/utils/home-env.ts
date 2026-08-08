/**
 * Point the process at a scratch home directory on every platform.
 *
 * `os.homedir()` reads `$HOME` on POSIX but `%USERPROFILE%` on Windows, so a
 * test that only sets `HOME` silently keeps resolving the real user profile
 * there. Setting both keeps `os.homedir()` and any `process.env.HOME` reader
 * pointing at the same scratch tree.
 */
const HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;

export function setTestHomeDir(directory: string): () => void {
	const previous = HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
	for (const name of HOME_VARIABLES) {
		process.env[name] = directory;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	};
}

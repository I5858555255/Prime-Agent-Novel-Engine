import { type ChildProcess, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";

const EXIT_STDIO_GRACE_MS = 100;

// Package managers ship as .cmd shims on Windows, which Node refuses to spawn
// without a shell.
const WINDOWS_SHELL_COMMANDS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack", "bun", "bunx"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

/**
 * Quote one argument for a `shell: true` spawn on Windows.
 *
 * Node builds that command line by joining the command and its arguments with
 * spaces and handing the result to `cmd.exe /d /s /c` verbatim — it does not
 * quote anything itself. Without this, any path containing a space (a user
 * profile like `C:\Users\Ada Lovelace`, most obviously) is split into two
 * arguments.
 */
export function quoteWindowsShellArg(value: string): string {
	if (value.length > 0 && !/[\s"&|<>^()]/.test(value)) {
		return value;
	}
	// Backslashes are only special immediately before a quote, where they must be
	// doubled; the quote itself is then escaped for the callee's own parser.
	const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
	return `"${escaped}"`;
}

export function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		const args = ["/T", "/PID", String(pid)];
		if (signal === "SIGKILL") {
			args.unshift("/F");
		}
		try {
			const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
			if (!result.error && result.status === 0) {
				return;
			}
		} catch {
			// Fall back to process.kill when taskkill is unavailable.
		}
	}
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already be fully reaped.
	}
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
function signalExitCode(signal: NodeJS.Signals | null): number | null {
	if (!signal) return null;
	const signalNumber = constants.signals[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	return code ?? signalExitCode(signal);
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(normalizedExitCode(exitCode, exitSignal));
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(normalizedExitCode(code, signal)), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
			finalize(normalizedExitCode(code, signal));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}

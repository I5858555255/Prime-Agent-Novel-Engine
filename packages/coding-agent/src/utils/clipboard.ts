import { spawn, spawnSync } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.js";
import { clipboard } from "./clipboard-native.js";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
	encoding: "buffer";
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	const xclipResult = spawnSync("xclip", ["-selection", "clipboard"], options);
	if (xclipResult.error || xclipResult.status !== 0) {
		const xselResult = spawnSync("xsel", ["--clipboard", "--input"], options);
		if (xselResult.error || xselResult.status !== 0) {
			throw new Error("Failed to copy using xclip and xsel");
		}
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = {
		input: text,
		timeout: 5000,
		stdio: ["pipe", "ignore", "ignore"],
		encoding: "buffer",
	};

	if (!copied) {
		try {
			if (p === "darwin") {
				const result = spawnSync("pbcopy", [], options);
				if (result.status === 0) copied = true;
			} else if (p === "win32") {
				const result = spawnSync("clip", [], options);
				if (result.status === 0) copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (process.env.TERMUX_VERSION) {
					const result = spawnSync("termux-clipboard-set", [], options);
					if (result.status === 0) copied = true;
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// Verify wl-copy exists
							const whichResult = spawnSync("which", ["wl-copy"], { stdio: "ignore" });
							if (whichResult.status !== 0) throw new Error("wl-copy not found");

							// wl-copy hangs with spawnSync due to fork behavior; use spawn instead
							const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
							proc.stdin.on("error", () => {
								// Ignore EPIPE errors if wl-copy exits early
							});
							proc.stdin.write(text);
							proc.stdin.end();
							proc.unref();
							copied = true;
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}

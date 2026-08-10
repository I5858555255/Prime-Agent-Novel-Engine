import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const project = join(root, "prime-agent-runtime", "kernel");
export const constraints = join(project, "constraints.txt");
export const toolchain = JSON.parse(readFileSync(join(project, "toolchain.json"), "utf8"));
export const supportedPlatforms = [
	{ target: "aarch64-apple-darwin", python: toolchain.managedPython, requireWheels: true },
	{ target: "x86_64-apple-darwin", python: toolchain.managedPython, requireWheels: true },
	{ target: "aarch64-unknown-linux-gnu", python: toolchain.managedPython, requireWheels: true },
	{ target: "x86_64-unknown-linux-gnu", python: toolchain.managedPython, requireWheels: true },
	{ target: "aarch64-unknown-linux-musl", python: toolchain.managedPython, requireWheels: true },
	{ target: "x86_64-unknown-linux-musl", python: toolchain.managedPython, requireWheels: true },
	{ target: "x86_64-pc-windows-msvc", python: toolchain.managedPython, requireWheels: true },
];

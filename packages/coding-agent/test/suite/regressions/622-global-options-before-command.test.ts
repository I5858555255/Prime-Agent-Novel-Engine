import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	daemonCommands: [] as string[][],
}));

vi.mock("../../../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

import { handlePublicCommand } from "../../../src/cli/public-command.js";

describe("issue #622 global options before commands", () => {
	beforeEach(() => {
		mocks.daemonCommands.length = 0;
	});

	it.each([
		["stop", ["worker"], ["kill", "worker"]],
		["rename", ["worker", "reviewer"], ["rename", "worker", "reviewer"]],
	])("routes %s with the daemon socket before or after the command", async (command, operands, internalArgs) => {
		for (const socketOption of ["--daemon-socket", "--socket"]) {
			const socketArgs = [socketOption, "/tmp/custom-daemon.sock"];

			await expect(handlePublicCommand([...socketArgs, command, ...operands])).resolves.toMatchObject({
				handled: true,
			});
			await expect(handlePublicCommand([command, ...operands, ...socketArgs])).resolves.toMatchObject({
				handled: true,
			});
		}

		expect(mocks.daemonCommands).toEqual([
			["daemon", ...internalArgs, "--daemon-socket", "/tmp/custom-daemon.sock"],
			["daemon", ...internalArgs, "--daemon-socket", "/tmp/custom-daemon.sock"],
			["daemon", ...internalArgs, "--socket", "/tmp/custom-daemon.sock"],
			["daemon", ...internalArgs, "--socket", "/tmp/custom-daemon.sock"],
		]);
	});
});

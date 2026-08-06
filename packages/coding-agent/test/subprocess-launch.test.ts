import { describe, expect, it } from "vitest";
import { formatCurrentCliCommand } from "../src/cli/subprocess-launch.js";

describe("formatCurrentCliCommand", () => {
	it("formats launcher recovery commands for POSIX shells", () => {
		expect(
			formatCurrentCliCommand(
				["shutdown", "--force"],
				{ PRIME_AGENT_LAUNCHER_PATH: "/opt/Prime Agent/prime-agent.sh" },
				"linux",
			),
		).toBe("'/opt/Prime Agent/prime-agent.sh' shutdown --force");
	});

	it("formats launcher recovery commands for PowerShell", () => {
		expect(
			formatCurrentCliCommand(
				["shutdown", "--force"],
				{ PRIME_AGENT_LAUNCHER_PATH: String.raw`C:\Program Files\Prime Agent\prime-agent.cmd` },
				"win32",
			),
		).toBe(String.raw`& 'C:\Program Files\Prime Agent\prime-agent.cmd' shutdown --force`);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	daemonCommands: [] as string[][],
	packageCommands: [] as string[][],
	psCalls: [] as boolean[],
	reapCalls: [] as Array<[boolean, boolean]>,
	shutdownCalls: [] as Array<[boolean, boolean]>,
}));

vi.mock("../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

vi.mock("../src/package-manager-cli.js", () => ({
	handlePackageCommand: async (args: string[]) => {
		mocks.packageCommands.push(args);
		return true;
	},
	isSelfUpdateSource: (source: string) => source === "self" || source === "pi" || source === "prime-agent",
}));

vi.mock("../src/cli/daemon-ps.js", () => ({
	runPs: async (json: boolean) => {
		mocks.psCalls.push(json);
	},
	runReap: async (json: boolean, force: boolean) => {
		mocks.reapCalls.push([json, force]);
	},
	runShutdownAll: async (json: boolean, force: boolean) => {
		mocks.shutdownCalls.push([json, force]);
	},
}));

import { formatTopLevelHelp } from "../src/cli/command-registry.js";
import { handlePublicCommand } from "../src/cli/public-command.js";

describe("public command routing", () => {
	beforeEach(() => {
		mocks.daemonCommands.length = 0;
		mocks.packageCommands.length = 0;
		mocks.psCalls.length = 0;
		mocks.reapCalls.length = 0;
		mocks.shutdownCalls.length = 0;
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("rewrites attach into the normal interactive resume path", async () => {
		await expect(handlePublicCommand(["attach", "worker"])).resolves.toEqual({
			handled: false,
			args: ["--resume", "worker"],
			explicitAgentsView: false,
			attachAgent: "worker",
		});
	});

	it("routes agent operations through the internal protocol adapter", async () => {
		await expect(handlePublicCommand(["list", "--all", "--json"])).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([["daemon", "list", "--all", "--json"]]);
	});

	it("separates Prime Agent updates from package updates", async () => {
		await handlePublicCommand(["update", "--force"]);
		await handlePublicCommand(["package", "update"]);
		await handlePublicCommand(["package", "update", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([
			["update", "--self", "--force"],
			["update", "--extensions"],
			["update", "npm:@example/tools"],
		]);
	});

	it("gives legacy update targets explicit migration guidance", async () => {
		for (const target of ["self", "--self", "prime-agent"]) {
			await handlePublicCommand(["update", target]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent update [--force]"'));
	});

	it("rejects self-update aliases on the package update path", async () => {
		for (const source of ["self", "pi", "prime-agent"]) {
			await handlePublicCommand(["package", "update", source]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent update"'));
	});

	it("maps model listing and session export to the existing runtime flags", async () => {
		await expect(handlePublicCommand(["model", "list", "sonnet"])).resolves.toMatchObject({
			handled: false,
			args: ["--list-models", "sonnet"],
		});
		await expect(handlePublicCommand(["session", "export", "session.jsonl", "session.html"])).resolves.toMatchObject({
			handled: false,
			args: ["--export", "session.jsonl", "session.html"],
		});
	});

	it("uses force only when explicitly requested for full shutdown", async () => {
		await handlePublicCommand(["shutdown", "--json"]);
		await handlePublicCommand(["shutdown", "--force"]);
		expect(mocks.shutdownCalls).toEqual([
			[true, false],
			[false, true],
		]);
	});

	it("routes doctor fixes through the safe cleanup path", async () => {
		await handlePublicCommand(["doctor", "--fix", "--json"]);
		expect(mocks.reapCalls).toEqual([[true, false]]);
	});

	it("rejects the old daemon hierarchy with migration guidance", async () => {
		await expect(handlePublicCommand(["daemon", "list"])).resolves.toMatchObject({ handled: true });
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Run "prime-agent help"'));
	});

	it("suggests close nested commands without executing them", async () => {
		await handlePublicCommand(["schedule", "cancell", "job-1"]);
		expect(mocks.daemonCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("schedule cancel"));
	});

	it("treats help-like message text after the separator literally", async () => {
		await handlePublicCommand(["send", "worker", "--", "--help"]);
		expect(mocks.daemonCommands).toEqual([["daemon", "send", "worker", "--", "--help"]]);
	});

	it("leaves natural-language prompts beginning with help on the prompt path", async () => {
		const args = ["help", "me", "fix", "this"];
		await expect(handlePublicCommand(args)).resolves.toEqual({
			handled: false,
			args,
			explicitAgentsView: false,
		});
	});

	it("shows command help when options precede the help flag", async () => {
		await handlePublicCommand(["list", "--all", "--help"]);
		await handlePublicCommand(["doctor", "--fix", "--help"]);
		await handlePublicCommand(["package", "install", "--local", "--help"]);

		expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining("prime-agent list [--all] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining("prime-agent doctor [--fix] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(3, expect.stringContaining("prime-agent package install <source>"));
		expect(console.error).not.toHaveBeenCalled();
	});

	it("leaves top-level help flags on the full CLI help path", async () => {
		await expect(handlePublicCommand(["--help"])).resolves.toEqual({
			handled: false,
			args: ["--help"],
			explicitAgentsView: false,
		});
		await expect(handlePublicCommand(["-h"])).resolves.toEqual({
			handled: false,
			args: ["-h"],
			explicitAgentsView: false,
		});
	});

	it("keeps daemon terminology out of public help", () => {
		const help = formatTopLevelHelp();
		expect(help).toContain("shutdown");
		expect(help).not.toContain("daemon");
	});
});

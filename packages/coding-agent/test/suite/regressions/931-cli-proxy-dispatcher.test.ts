import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentOptions: [] as Array<Record<string, unknown>>,
	closeOwnedSessionWorkerOwnerWatch: vi.fn(),
	installOwnedSessionWorkerOwnerWatch: vi.fn(),
	main: vi.fn(async () => {}),
	maybeRunOwnedSessionWorkerFrontend: vi.fn(async () => false),
	maybeStartDaemonEarly: vi.fn(),
	setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => ({
	EnvHttpProxyAgent: class EnvHttpProxyAgent {
		constructor(options: Record<string, unknown>) {
			mocks.agentOptions.push(options);
		}
	},
	setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

vi.mock("../../../src/cli/daemon-launch.js", () => ({
	maybeStartDaemonEarly: mocks.maybeStartDaemonEarly,
}));

vi.mock("../../../src/cli/owned-session-worker.js", () => ({
	closeOwnedSessionWorkerOwnerWatch: mocks.closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch: mocks.installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess: () => false,
	maybeRunOwnedSessionWorkerFrontend: mocks.maybeRunOwnedSessionWorkerFrontend,
}));

vi.mock("../../../src/main.js", () => ({
	main: mocks.main,
}));

import { runCli } from "../../../src/cli-main.js";

describe("CLI proxy dispatcher", () => {
	const originalArgv = process.argv;
	const originalEmitWarning = process.emitWarning;
	const originalPiCodingAgent = process.env.PI_CODING_AGENT;
	const originalTitle = process.title;

	beforeEach(() => {
		mocks.agentOptions.length = 0;
		vi.clearAllMocks();
		process.argv = ["node", "pi"];
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.emitWarning = originalEmitWarning;
		process.title = originalTitle;
		if (originalPiCodingAgent === undefined) {
			delete process.env.PI_CODING_AGENT;
		} else {
			process.env.PI_CODING_AGENT = originalPiCodingAgent;
		}
	});

	it("installs an unlimited-timeout environment proxy dispatcher before main", async () => {
		await runCli();

		expect(mocks.agentOptions).toEqual([{ bodyTimeout: 0, headersTimeout: 0 }]);
		expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
		expect(mocks.setGlobalDispatcher.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.main.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(mocks.main).toHaveBeenCalledWith([]);
		expect(mocks.closeOwnedSessionWorkerOwnerWatch).toHaveBeenCalledTimes(1);
	});
});

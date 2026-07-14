import { describe, expect, it, vi } from "vitest";
import type { AgentTraceUploadAllResult, AgentTraceUploadResult } from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface TracesCommandContext {
	settingsManager: { getAgentTracesEnabled: () => boolean };
	modelRegistry: { authStorage: AuthStorage };
	previewCurrentTrace: () => Promise<void>;
	uploadCurrentTraceOnce: () => Promise<AgentTraceUploadResult>;
	uploadAllTraces: () => Promise<AgentTraceUploadAllResult>;
	formatTraceUploadResult: (result: AgentTraceUploadResult) => string;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
}

interface TracesCommandPrototype {
	handleTracesCommand(this: TracesCommandContext, text: string): Promise<void>;
}

const prototype = InteractiveMode.prototype as unknown as TracesCommandPrototype;

function makeContext(enabled = true): TracesCommandContext {
	return {
		settingsManager: { getAgentTracesEnabled: () => enabled },
		modelRegistry: {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
		},
		previewCurrentTrace: vi.fn(async () => {}),
		uploadCurrentTraceOnce: vi.fn(
			async (): Promise<AgentTraceUploadResult> => ({
				status: "uploaded",
				sessionId: "current",
				traceId: "current",
				bytesStored: 12,
			}),
		),
		uploadAllTraces: vi.fn(
			async (): Promise<AgentTraceUploadAllResult> => ({
				total: 2,
				uploaded: 2,
				failed: 0,
				skipped: 0,
				bytesStored: 24,
				results: [],
			}),
		),
		formatTraceUploadResult: vi.fn(() => "Trace uploaded (12 bytes)."),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
}

describe("InteractiveMode /traces", () => {
	it("previews without enabling trace sharing", async () => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, "/traces preview");

		expect(context.previewCurrentTrace).toHaveBeenCalledOnce();
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
		expect(context.uploadAllTraces).not.toHaveBeenCalled();
	});

	it.each(["/traces upload", "/traces upload-current"])("uploads only the current trace for %s", async (command) => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, command);

		expect(context.uploadCurrentTraceOnce).toHaveBeenCalledOnce();
		expect(context.uploadAllTraces).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Trace uploaded (12 bytes).");
	});

	it("backfills all discovered traces only for upload-all", async () => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, "/traces upload-all");

		expect(context.uploadAllTraces).toHaveBeenCalledOnce();
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Uploaded 2 of 2 traces; 24 bytes stored.");
	});
});

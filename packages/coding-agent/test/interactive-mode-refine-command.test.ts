import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const handleRefineCommand = Reflect.get(InteractiveMode.prototype, "handleRefineCommand") as (
	this: {
		agentConnection: {
			getSessionStats: ReturnType<typeof vi.fn>;
			refine: ReturnType<typeof vi.fn>;
		};
		stopWorkingLoader: ReturnType<typeof vi.fn>;
		showStatus: ReturnType<typeof vi.fn>;
		showWarning: ReturnType<typeof vi.fn>;
		showError: ReturnType<typeof vi.fn>;
	},
	args?: string,
) => Promise<void>;

describe("InteractiveMode.handleRefineCommand", () => {
	test("requires a refinement id for rollback", async () => {
		const context = {
			agentConnection: {
				getSessionStats: vi.fn().mockResolvedValue({ totalMessages: 2 }),
				refine: vi.fn(),
			},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "rollback");

		expect(context.showWarning).toHaveBeenCalledWith("Usage: /refine rollback <refinement-id>");
		expect(context.agentConnection.refine).not.toHaveBeenCalled();
		expect(context.stopWorkingLoader).not.toHaveBeenCalled();
	});
});

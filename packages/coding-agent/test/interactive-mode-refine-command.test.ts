import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const handleRefineCommand = Reflect.get(InteractiveMode.prototype, "handleRefineCommand") as (
	this: {
		sessionManager: { getEntries: () => Array<{ type: string }> };
		session: { refine: ReturnType<typeof vi.fn> };
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
			sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }] },
			session: { refine: vi.fn() },
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await handleRefineCommand.call(context, "rollback");

		expect(context.showWarning).toHaveBeenCalledWith("Usage: /refine rollback <refinement-id>");
		expect(context.session.refine).not.toHaveBeenCalled();
		expect(context.stopWorkingLoader).not.toHaveBeenCalled();
	});
});

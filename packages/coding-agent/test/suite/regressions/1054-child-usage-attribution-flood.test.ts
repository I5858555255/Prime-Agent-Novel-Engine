import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("#1054 child usage attribution flood", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
	});

	it("persists one usage attribution for a tool-heavy child turn", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: typeof params === "object" && params !== null && "value" in params ? String(params.value) : "",
					},
				],
				details: {},
			}),
		};
		child = await createHarness({ tools: [echo] });
		parent = await createHarness({
			persistSession: true,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		parent.setResponses([fauxAssistantMessage("starting child")]);
		await parent.session.prompt("prepare");
		child.setResponses([
			...Array.from({ length: 50 }, (_, index) =>
				fauxAssistantMessage([fauxToolCall("echo", { value: String(index) })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("done"),
		]);

		await parent.session.runRlmChild("run tool-heavy task");
		await expect.poll(() => child!.session.getLastAssistantText()).toBe("done");
		await expect
			.poll(() => parent!.sessionManager.getEntries().filter((entry) => entry.type === "child_usage_attributed"))
			.toHaveLength(1);

		const sessionFile = parent.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("parent session file was not created");
		expect(readFileSync(sessionFile, "utf8").match(/"type":"child_usage_attributed"/g)).toHaveLength(1);
	});
});

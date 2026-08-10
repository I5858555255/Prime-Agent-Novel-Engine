import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { createHarness, getMessageText } from "../harness.js";

describe("#886 Bedrock side-question context", () => {
	it("removes tool protocol messages while preserving conversational text", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxText("I will inspect the value."), fauxToolCall("echo", { text: "kestrel" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The inspected value is kestrel."),
			]);
			await harness.session.prompt("Inspect the project value.");

			harness.setResponses([
				(context) => {
					expect(context.tools).toEqual([]);
					expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
					expect(context.messages.map(getMessageText)).toEqual([
						"Inspect the project value.",
						"I will inspect the value.\nThe inspected value is kestrel.",
						expect.stringContaining("What was the inspected value?"),
					]);
					for (let index = 1; index < context.messages.length; index++) {
						expect(context.messages[index]?.role).not.toBe(context.messages[index - 1]?.role);
					}
					expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
					expect(
						context.messages.some(
							(message) =>
								message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
						),
					).toBe(false);
					return fauxAssistantMessage("kestrel");
				},
			]);

			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"bedrock-question",
				"What was the inspected value?",
				(event) => {
					events.push(event);
				},
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "kestrel" });
		} finally {
			harness.cleanup();
		}
	});
});

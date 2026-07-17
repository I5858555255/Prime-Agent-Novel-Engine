import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousRuntimeState } from "../../../src/core/autonomous.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

describe("ENG-4685 daemon client modes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs host-owned autonomous gate retries through the shared completion loop", async () => {
		const gate = `${process.execPath} -e "process.exit(0)"`;
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: { commands: [gate], maxRetries: 2 },
			},
		});
		harnesses.push(harness);
		const state = (
			harness.session as unknown as {
				_autonomousState: AutonomousRuntimeState;
			}
		)._autonomousState;
		state.gateAttempts[gate] = 1;
		state.lastGateFailure = {
			command: gate,
			attempt: 1,
			exitText: "exited 1",
			output: "gate failed",
		};
		harness.setResponses([fauxAssistantMessage("I fixed the gate failure.")]);

		const status = await waitForHeadlessCompletion(harness.session);

		expect(getUserTexts(harness)).toHaveLength(1);
		expect(getUserTexts(harness)[0]).toContain("Autonomous quality gate failed");
		expect(getAssistantTexts(harness)).toEqual(["I fixed the gate failure."]);
		expect(status).toMatchObject({
			continuationsUsed: 1,
			lastGateFailure: undefined,
		});
	});
});

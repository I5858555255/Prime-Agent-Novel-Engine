import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	DEFAULT_AUTONOMOUS_FINISH_PROMPT,
	hasAutonomousFinishEvidence,
	shouldAutonomouslyContinue,
} from "../../src/core/autonomous.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

describe("AgentSession autonomous mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects a host-side continuation when the assistant asks the user for help", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2, finishContract: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Which package manager should I use?"),
			fauxAssistantMessage("I inspected the repo and used npm."),
		]);

		await harness.session.prompt("fix the project");

		expect(getAssistantTexts(harness)).toEqual([
			"Which package manager should I use?",
			"I inspected the repo and used npm.",
		]);
		expect(getUserTexts(harness)).toEqual(["fix the project", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not continue through a concrete external blocker", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Blocked: this requires an API key credential from the user.")]);

		await harness.session.prompt("run the private eval");

		expect(getUserTexts(harness)).toEqual(["run the private eval"]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 0,
			turnsUsed: 1,
		});
	});

	it("stops after the configured autonomous continuation limit", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1, finishContract: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Can you confirm the test command?"),
			fauxAssistantMessage("Can you confirm whether to run lint too?"),
		]);

		await harness.session.prompt("make the change");

		expect(getAssistantTexts(harness)).toEqual([
			"Can you confirm the test command?",
			"Can you confirm whether to run lint too?",
		]);
		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("supports /autonomous on and off without calling the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on");
		await harness.session.prompt("/autonomous off");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		const statusMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "autonomous_status",
		);
		expect(statusMessages).toHaveLength(2);
	});

	it("continues when the assistant tries to finish without contract evidence", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I think it works."),
			fauxAssistantMessage("I ran npm test and all tests passed."),
		]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_FINISH_PROMPT]);
		expect(getAssistantTexts(harness)).toEqual(["I think it works.", "I ran npm test and all tests passed."]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("accepts an existing git patch as finish evidence", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		harnesses.push(harness);
		execFileSync("git", ["init"], { cwd: harness.tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: harness.tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: harness.tempDir });
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "before\n");
		execFileSync("git", ["add", "file.txt"], { cwd: harness.tempDir });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: harness.tempDir, stdio: "ignore" });
		writeFileSync(path, "after\n");
		harness.setResponses([fauxAssistantMessage("Done.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change"]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("accepts passing quality gates as finish evidence", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change"]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("feeds failing quality gate output back into autonomous mode", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: {
					commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
					maxRetries: 1,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("I wrote BLOCKER.md with evidence.")]);

		await harness.session.prompt("make the change");

		const users = getUserTexts(harness);
		expect(users[0]).toBe("make the change");
		expect(users[1]).toContain("Autonomous quality gate failed");
		expect(users[1]).toContain("gate failed");
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("classifies soft blockers separately from real external blockers", () => {
		const state = createAutonomousRuntimeState({ enabled: true });

		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("I'm blocked. What should I try next?")),
		).toMatchObject({
			shouldContinue: true,
			reason: "asks_user",
		});
		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("Blocked: this requires OAuth login from the user.")),
		).toMatchObject({
			shouldContinue: false,
			reason: "real_blocker",
		});
	});

	it("accepts no-op and test evidence in finish classification", () => {
		expect(
			hasAutonomousFinishEvidence("No-op: no changes needed because the requested behavior already exists."),
		).toBe(true);
		expect(hasAutonomousFinishEvidence("I ran npm test and tests passed.")).toBe(true);
		expect(hasAutonomousFinishEvidence("I think it works.")).toBe(false);
	});
});

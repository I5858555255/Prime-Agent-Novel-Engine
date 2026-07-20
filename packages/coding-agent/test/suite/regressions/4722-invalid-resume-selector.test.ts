import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { findClosestSessionId, SessionSelectorNotFoundError } from "../../../src/cli/session-resolver.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createSessionManager } from "../../../src/main.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4722 invalid resume selectors", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("rejects a mistyped session ID with the closest saved ID", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("saved")]);
		await harness.session.prompt("persist this session");

		const sessionId = harness.session.sessionId;
		const lastCharacter = sessionId.at(-1)!;
		const mistypedId = `${sessionId.slice(0, -1)}${lastCharacter === "0" ? "1" : "0"}`;
		const parsed = parseArgs(["--resume", mistypedId, "do not submit this"]);
		const sessionDir = join(harness.tempDir, "sessions");

		await expect(
			createSessionManager(parsed, harness.tempDir, sessionDir, SettingsManager.inMemory()),
		).rejects.toMatchObject({
			name: SessionSelectorNotFoundError.name,
			selector: mistypedId,
			suggestion: sessionId,
		});
		expect(parsed.resume).toBe(mistypedId);
		expect(parsed.messages).toEqual(["do not submit this"]);
	});

	it("does not suggest tied or low-confidence session IDs", () => {
		expect(findClosestSessionId("abcx", [{ id: "abca1111" }, { id: "abcb2222" }])).toBeUndefined();
		expect(findClosestSessionId("wxyz1234", [{ id: "abcdef0123456789" }])).toBeUndefined();
		expect(findClosestSessionId("abcd", [])).toBeUndefined();
	});
});

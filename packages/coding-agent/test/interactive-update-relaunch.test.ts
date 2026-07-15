import { describe, expect, it } from "vitest";
import {
	buildUpdateChildArgs,
	buildUpdateRelaunchArgs,
	resolveInteractiveUpdateDaemonSocketPath,
	updateArgsIncludeSelf,
} from "../src/modes/interactive/interactive-mode.js";

describe("buildUpdateRelaunchArgs", () => {
	it("relaunches the current session with the supported resume flag", () => {
		expect(buildUpdateRelaunchArgs(["--model", "gpt-5"], "/tmp/session.jsonl")).toEqual([
			"--model",
			"gpt-5",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("keeps an existing resume selection", () => {
		expect(buildUpdateRelaunchArgs(["--resume", "/tmp/other.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--resume",
			"/tmp/other.jsonl",
		]);
	});

	it("does not treat the unsupported session flag as an existing selection", () => {
		expect(buildUpdateRelaunchArgs(["--session", "/tmp/old.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--session",
			"/tmp/old.jsonl",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});
});

describe("buildUpdateChildArgs", () => {
	it("passes the active custom socket to the deferred self-update child", () => {
		expect(buildUpdateChildArgs(["--self", "--force"], "/tmp/custom-daemon.sock")).toEqual([
			"--self",
			"--force",
			"--daemon-socket",
			"/tmp/custom-daemon.sock",
		]);
	});

	it("keeps an explicitly selected update socket", () => {
		expect(buildUpdateChildArgs(["--self", "--daemon-socket", "/tmp/explicit.sock"], "/tmp/active.sock")).toEqual([
			"--self",
			"--daemon-socket",
			"/tmp/explicit.sock",
		]);
		expect(
			resolveInteractiveUpdateDaemonSocketPath(
				["--self", "--daemon-socket", "/tmp/explicit.sock"],
				"/tmp/active.sock",
			),
		).toBe("/tmp/explicit.sock");
		expect(updateArgsIncludeSelf(["--daemon-socket", "/tmp/explicit.sock"])).toBe(true);
	});
});

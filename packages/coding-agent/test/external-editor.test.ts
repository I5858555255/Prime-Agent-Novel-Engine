import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runExternalEditor } from "../src/modes/interactive/external-editor.js";
import { createDeferred } from "./suite/scheduling.js";

const childProcessMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, spawnSync: childProcessMocks.spawnSync };
});

type ExternalEditorTui = Parameters<typeof runExternalEditor>[0]["tui"];

function createTui(events: string[], drainInput: () => Promise<void>): ExternalEditorTui {
	return {
		terminal: {
			drainInput: vi.fn(drainInput),
		},
		start: vi.fn(() => events.push("start")),
		stop: vi.fn(() => events.push("stop")),
		requestRender: vi.fn(() => events.push("render")),
	};
}

describe("runExternalEditor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		childProcessMocks.spawnSync.mockReset();
	});

	test("drains before spawning, returns edited content, and restores the TUI", async () => {
		const drain = createDeferred();
		const events: string[] = [];
		const tui = createTui(events, () =>
			drain.promise.then(() => {
				events.push("drain");
			}),
		);
		let tmpFile: string | undefined;
		childProcessMocks.spawnSync.mockImplementation((command: string, args: string[]) => {
			events.push("spawn");
			tmpFile = args.at(-1);
			if (!tmpFile) throw new Error("missing temp file");
			writeFileSync(tmpFile, "edited\n", "utf-8");
			return { command, status: 0 };
		});

		const result = runExternalEditor({
			tui,
			command: "vim -f",
			content: "draft",
			onTuiRestart: () => events.push("restart-hook"),
		});

		expect(tui.terminal.drainInput).toHaveBeenCalledWith(1000);
		expect(tui.stop).not.toHaveBeenCalled();
		expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
		drain.resolve();

		await expect(result).resolves.toBe("edited");
		expect(events).toEqual(["drain", "stop", "spawn", "start", "restart-hook", "render"]);
		expect(childProcessMocks.spawnSync).toHaveBeenCalledWith("vim", ["-f", tmpFile], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		expect(tmpFile && existsSync(tmpFile)).toBe(false);
	});

	test("preserves the draft after a nonzero editor exit", async () => {
		const events: string[] = [];
		const tui = createTui(events, async () => {
			events.push("drain");
		});
		let tmpFile: string | undefined;
		childProcessMocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
			events.push("spawn");
			tmpFile = args.at(-1);
			return { status: 1 };
		});

		await expect(runExternalEditor({ tui, command: "vim", content: "draft" })).resolves.toBeUndefined();

		expect(events).toEqual(["drain", "stop", "spawn", "start", "render"]);
		expect(tmpFile && existsSync(tmpFile)).toBe(false);
	});

	test("restores the stopped TUI when spawning throws", async () => {
		const events: string[] = [];
		const tui = createTui(events, async () => {
			events.push("drain");
		});
		const spawnError = new Error("spawn failed");
		childProcessMocks.spawnSync.mockImplementation(() => {
			events.push("spawn");
			throw spawnError;
		});

		await expect(runExternalEditor({ tui, command: "vim", content: "draft" })).rejects.toBe(spawnError);

		expect(events).toEqual(["drain", "stop", "spawn", "start", "render"]);
		expect(tui.start).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});

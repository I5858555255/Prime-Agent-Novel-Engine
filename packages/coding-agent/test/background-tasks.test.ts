import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../src/core/background-tasks.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-background-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("BackgroundTaskManager", () => {
	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("reads only the requested tail of a large log", () => {
		const manager = new BackgroundTaskManager({ logDir: createTempDir() });
		const task = manager.createTask({ kind: "bash", title: "tail", input: "tail" });
		task.markBackgrounded();
		task.append("a".repeat(100));

		const read = manager.read(task.id, 10);

		expect(read?.output).toContain("[showing last 10 bytes");
		expect(read?.output.endsWith("aaaaaaaaaa")).toBe(true);
	});

	it("preserves UTF-8 characters split across chunks", () => {
		const manager = new BackgroundTaskManager({ logDir: createTempDir() });
		const task = manager.createTask({ kind: "bash", title: "utf8", input: "utf8" });
		const bytes = Buffer.from("é", "utf8");
		task.markBackgrounded();
		task.appendBuffer(bytes.subarray(0, 1));
		task.appendBuffer(bytes.subarray(1));
		task.complete();

		const read = manager.read(task.id);

		expect(read?.output).toContain("é");
		expect(read?.output).not.toContain("�");
	});

	it("marks non-zero completions as errors", () => {
		const manager = new BackgroundTaskManager({ logDir: createTempDir() });
		const task = manager.createTask({ kind: "bash", title: "fail", input: "fail" });
		task.markBackgrounded();
		task.complete({ exitCode: 2 });

		expect(manager.get(task.id)).toMatchObject({ status: "error", errorMessage: "Exit code 2" });
	});

	it("cleans owned temporary log directories on dispose", () => {
		const manager = new BackgroundTaskManager();
		const task = manager.createTask({ kind: "bash", title: "dispose", input: "dispose" });
		const logDir = dirname(task.logPath);
		task.markBackgrounded();
		expect(existsSync(logDir)).toBe(true);

		manager.dispose();

		expect(existsSync(logDir)).toBe(false);
	});
});

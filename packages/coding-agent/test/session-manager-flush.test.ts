import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-flush-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("SessionManager.flushNow", () => {
	it("writes the session file with all in-memory entries before any assistant message", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		// Append a custom entry (goal state) — normally suppressed by _persist
		// because no assistant message exists yet.
		mgr.appendCustomEntry("thread_goal_state", { active: true, status: "active" });

		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(false);

		// flushNow forces a write despite the no-assistant guard
		mgr.flushNow();
		expect(existsSync(file)).toBe(true);

		const content = readFileSync(file, "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2); // header + custom entry

		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");

		const custom = JSON.parse(lines[1]!);
		expect(custom.type).toBe("custom");
		expect(custom.customType).toBe("thread_goal_state");
		expect(custom.data).toEqual({ active: true, status: "active" });
	});

	it("is a no-op for in-memory (non-persisted) sessions", () => {
		const mgr = SessionManager.inMemory("/tmp");
		mgr.appendCustomEntry("thread_goal_state", { active: true });
		// Should not throw
		mgr.flushNow();
		expect(mgr.getSessionFile()).toBeUndefined();
	});

	it("preserves subsequent rewrite behavior after flush with user then assistant", () => {
		const dir = createTempDir();
		const sessionDir = join(dir, "sessions");
		const mgr = SessionManager.create(dir, sessionDir);

		mgr.appendCustomEntry("thread_goal_state", { active: true, status: "active" });
		mgr.flushNow();

		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		// Append a USER message first — this sets flushed=false because
		// no assistant exists yet, exercising the pending full-rewrite path.
		mgr.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		// Then append an ASSISTANT message — this triggers the full rewrite
		// (not appendFileSync) because flushed is false.
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// File should contain exactly: header, custom(goal), user, assistant
		const content = readFileSync(file, "utf8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(4);

		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");

		const custom = JSON.parse(lines[1]!);
		expect(custom.type).toBe("custom");
		expect(custom.customType).toBe("thread_goal_state");

		const userMsg = JSON.parse(lines[2]!);
		expect(userMsg.type).toBe("message");
		expect(userMsg.message.role).toBe("user");

		const assistantMsg = JSON.parse(lines[3]!);
		expect(assistantMsg.type).toBe("message");
		expect(assistantMsg.message.role).toBe("assistant");

		// Verify valid parent chain: custom(null) -> user(custom) -> assistant(user)
		// (session header is not part of the entry parent chain)
		expect(custom.parentId).toBeNull();
		expect(userMsg.parentId).toBe(custom.id);
		expect(assistantMsg.parentId).toBe(userMsg.id);
	});
});

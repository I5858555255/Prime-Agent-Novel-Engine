import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createAgentsViewResumeConfig, resolveAgentsViewOpenCwd } from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "./utilities.js";

// End-to-end check of the ENG-4369 open path: a session whose stored cwd was
// deleted must still open instead of failing on the daemon's cwd assertion.
describe("agents view open with a missing session cwd", () => {
	it("repros the failure and proves the override opens the session", async () => {
		const root = mkdtempSync(join(tmpdir(), "agents-view-missing-cwd-"));
		const launchCwd = join(root, "launch");
		const worktree = join(root, "worktree");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		try {
			mkdirSync(launchCwd, { recursive: true }); // launch dir exists; the session's own dir won't
			const session = SessionManager.create(worktree, sessionDir);
			session.appendMessage(userMsg("do the thing"));
			session.appendMessage(assistantMsg("done"));
			const sessionFile = session.getSessionFile()!;

			// The worktree the session was created in is removed (the real scenario).
			rmSync(worktree, { recursive: true, force: true });

			const factory = async () => {
				throw new Error("runtime factory should not be reached when the cwd is missing");
			};

			// Bug repro: with cwd stripped, the session resolves against its stored
			// (now-deleted) cwd and throws before the runtime is ever built — exactly
			// the flicker users saw.
			const stripped = await SessionManager.openAsync(sessionFile, sessionDir);
			await expect(
				createAgentSessionRuntime(factory, {
					cwd: stripped.getCwd(),
					agentDir,
					sessionManager: stripped,
				}),
			).rejects.toThrowError(MissingSessionCwdError);

			// Fix: resolveAgentsViewOpenCwd detects the missing dir and the resume
			// config carries the launch cwd as an override, so the session opens
			// against a real directory.
			const summary: SessionSummary = {
				id: session.getSessionId(),
				lifecycle: "live",
				activity: "idle",
				sessionId: session.getSessionId(),
				sessionFile,
				cwd: worktree,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 2,
				pendingMessageCount: 0,
			};
			const { overrideCwd, notice } = resolveAgentsViewOpenCwd(summary, launchCwd);
			expect(overrideCwd).toBe(launchCwd);
			expect(notice).toContain(worktree);

			const resumeConfig = createAgentsViewResumeConfig({ cwd: launchCwd, agentDir }, overrideCwd);
			const overridden = await SessionManager.openAsync(sessionFile, sessionDir, resumeConfig.cwd);
			expect(overridden.getCwd()).toBe(launchCwd);

			// With the override the session now resolves against the real launch dir,
			// so the runtime build gets past the cwd guard and into the factory
			// (which we stop at, having proven the guard no longer fires).
			let factoryCwd: string | undefined;
			const okFactory = async (opts: { cwd: string }) => {
				factoryCwd = opts.cwd;
				throw new Error("stop after the cwd guard");
			};
			await expect(
				createAgentSessionRuntime(okFactory as never, {
					cwd: overridden.getCwd(),
					agentDir,
					sessionManager: overridden,
				}),
			).rejects.toThrow("stop after the cwd guard");
			expect(factoryCwd).toBe(launchCwd);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { removeTempDirSync } from "./utils/temp-fs.js";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			removeTempDirSync(tempDir);
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const expectedSessionDir = join(agentDir, "sessions");
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(expectedSessionDir + sep)).toBe(true);

		await session.disposeAsync();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		await session.disposeAsync();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
			tools: ["ipython"],
		});

		expect(session.sessionManager).toBe(sessionManager);
		// The prompt reports a POSIX-style path so the code the model writes works
		// in both Python and bash on Windows.
		expect(session.systemPrompt).toContain(`Working directory: ${sessionCwd.replaceAll("\\", "/")}`);

		const ipythonTool = session.agent.state.tools.find((tool) => tool.name === "ipython");
		expect(ipythonTool).toBeTruthy();
		// Git Bash `pwd` prints an MSYS path (`/tmp/...`) resolved through its own
		// mount table; `pwd -W` prints the Windows path the test can compare.
		const pwdCode = process.platform === "win32" ? "%%bash\npwd -W" : "%%bash\npwd";
		const result = await ipythonTool!.execute("test", { code: pwdCode });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		await session.disposeAsync();
	});
});

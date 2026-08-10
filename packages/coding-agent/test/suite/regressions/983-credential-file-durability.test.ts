import type { PathLike, PathOrFileDescriptor, WriteFileOptions } from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsEvents = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync(path: PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions) {
			if (typeof path !== "number") {
				fsEvents.events.push(`write:${String(path)}`);
			}
			return actual.writeFileSync(path, data, options);
		},
		renameSync(oldPath: PathLike, newPath: PathLike) {
			fsEvents.events.push(`rename:${String(newPath)}`);
			return actual.renameSync(oldPath, newPath);
		},
	};
});

import { ENV_AGENT_DIR } from "../../../src/config.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { FileSettingsStorage } from "../../../src/core/settings-manager.js";
import { migrateAuthToAuthJson } from "../../../src/migrations.js";

describe("regression #983: credential file durability", () => {
	let tempDir: string;
	let agentDir: string;
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-983-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		fsEvents.events.length = 0;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function expectNoLeftoverTempFiles(dir: string) {
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	}

	function expectRestrictiveMode(path: string) {
		// Windows cannot express POSIX modes; a writable file stats as 0o666 there.
		const expected = process.platform === "win32" ? 0o666 : 0o600;
		expect(statSync(path).mode & 0o777).toBe(expected);
	}

	it("migrates credentials to auth.json before touching oauth.json or settings.json", () => {
		process.env[ENV_AGENT_DIR] = agentDir;
		const authPath = join(agentDir, "auth.json");
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 1 } }));
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-test" } }));

		fsEvents.events.length = 0;
		const providers = migrateAuthToAuthJson();

		expect(providers.sort()).toEqual(["anthropic", "openai"]);
		const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { type: string }>;
		expect(auth.anthropic.type).toBe("oauth");
		expect(auth.openai).toEqual({ type: "api_key", key: "sk-test" });
		expectRestrictiveMode(authPath);
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(true);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(settings.apiKeys).toBeUndefined();
		expect(settings.theme).toBe("dark");
		expectNoLeftoverTempFiles(agentDir);

		// auth.json must be durable before the old locations are modified.
		const authWriteIndex = fsEvents.events.indexOf(`rename:${authPath}`);
		const settingsWriteIndex = fsEvents.events.indexOf(`rename:${settingsPath}`);
		const oauthRenameIndex = fsEvents.events.indexOf(`rename:${oauthPath}.migrated`);
		expect(authWriteIndex).toBeGreaterThanOrEqual(0);
		expect(settingsWriteIndex).toBeGreaterThan(authWriteIndex);
		expect(oauthRenameIndex).toBeGreaterThan(authWriteIndex);
	});

	it("re-reads settings under the lock before first-time creation", () => {
		const settingsPath = join(agentDir, "settings.json");
		const storage = new FileSettingsStorage(tempDir, agentDir);

		const seen: (string | undefined)[] = [];
		storage.withLock("global", (current) => {
			seen.push(current);
			if (current === undefined) {
				// Simulate a concurrent process creating the file first.
				writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
				return JSON.stringify({ theme: "light" });
			}
			return JSON.stringify({ ...JSON.parse(current), defaultModel: "claude-sonnet" });
		});

		expect(seen).toHaveLength(2);
		expect(seen[0]).toBeUndefined();
		expect(JSON.parse(seen[1]!)).toEqual({ theme: "dark" });
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
			theme: "dark",
			defaultModel: "claude-sonnet",
		});
	});

	it("writes settings.json via temp file and rename", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
		const storage = new FileSettingsStorage(tempDir, agentDir);

		fsEvents.events.length = 0;
		storage.withLock("global", () => JSON.stringify({ theme: "light" }));

		expect(fsEvents.events).toContain(`rename:${settingsPath}`);
		expect(fsEvents.events).not.toContain(`write:${settingsPath}`);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "light" });
		expectNoLeftoverTempFiles(agentDir);
	});

	it("writes auth.json via temp file and rename with 0600 permissions on set", () => {
		const authPath = join(agentDir, "auth.json");
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });

		fsEvents.events.length = 0;
		storage.set("openai", { type: "api_key", key: "sk-test" });

		expect(fsEvents.events).toContain(`rename:${authPath}`);
		expect(fsEvents.events).not.toContain(`write:${authPath}`);
		expectRestrictiveMode(authPath);
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			openai: { type: "api_key", key: "sk-test" },
		});
		expectNoLeftoverTempFiles(agentDir);
	});

	it("writes auth.json via temp file and rename with 0600 permissions on OAuth refresh", async () => {
		const providerId = `test-oauth-983-${Math.random().toString(36).slice(2)}`;
		registerOAuthProvider({
			id: providerId,
			name: "Test OAuth Provider",
			async login() {
				throw new Error("Not used in this test");
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "refreshed-access-token",
					expires: Date.now() + 60_000,
				};
			},
			getApiKey(credentials) {
				return `Bearer ${credentials.access}`;
			},
		});

		const authPath = join(agentDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			}),
		);
		const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });

		fsEvents.events.length = 0;
		const apiKey = await storage.getApiKey(providerId);

		expect(apiKey).toBe("Bearer refreshed-access-token");
		expect(fsEvents.events).toContain(`rename:${authPath}`);
		expect(fsEvents.events).not.toContain(`write:${authPath}`);
		expectRestrictiveMode(authPath);
		expectNoLeftoverTempFiles(agentDir);
	});
});

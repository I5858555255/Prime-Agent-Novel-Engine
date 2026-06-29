import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).not.toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");

		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes mcp.refresh and mcp.begin_login host handlers", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers)).toEqual(["mcp.refresh", "mcp.begin_login"]);

		// refresh with no credentials is a no-op that does not throw.
		await expect(handlers["mcp.refresh"]({ server: "linear" })).resolves.toEqual({});
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("begin_login errors when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		await expect(handlers["mcp.begin_login"]({ server: "linear" })).rejects.toThrow("not available");
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});
});

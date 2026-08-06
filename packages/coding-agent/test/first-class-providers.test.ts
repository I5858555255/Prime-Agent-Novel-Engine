import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resolveCliModel } from "../src/core/model-resolver.js";
import { ProviderAuthFlows } from "../src/modes/interactive/auth-flows.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createOverlayHandle(): OverlayHandle {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => true,
	};
}

function createFakeTui(overlays: Component[]): TUI {
	return {
		terminal: { columns: 88, rows: 30 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlays.push(component);
			return createOverlayHandle();
		}),
	} as unknown as TUI;
}

describe("first-class provider CLI integration", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-first-class-providers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authStorage = AuthStorage.create(join(tempDir, "auth.json"), { usePrimeCliConfig: false });
		modelRegistry = ModelRegistry.inMemory(authStorage);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves provider and model flags without custom models.json entries", () => {
		const cases = [
			{ provider: "cline-pass", model: "cline-pass/qwen3.7-max" },
			{ provider: "meta", model: "muse-spark-1.2" },
			{ provider: "alibaba-token-plan", model: "qwen3.8-max" },
		];

		for (const candidate of cases) {
			const result = resolveCliModel({
				cliProvider: candidate.provider,
				cliModel: candidate.model,
				modelRegistry,
			});
			expect(result.error).toBeUndefined();
			expect(result.model).toMatchObject({ provider: candidate.provider, id: candidate.model });
		}
	});
	it("stores auth.json credentials through the native API-key login flow", async () => {
		const overlays: Component[] = [];
		const statusMessages: string[] = [];
		const authFlows = new ProviderAuthFlows({
			ui: createFakeTui(overlays),
			modelRegistry,
			showStatus: (message) => statusMessages.push(message),
			showError: (message) => {
				throw new Error(message);
			},
			getAvailableModels: async () => [],
		});
		const credentials = [
			{ id: "cline-pass", key: "cline-key" },
			{ id: "meta", key: "meta-key" },
			{ id: "alibaba-token-plan", key: "sk-sp-key" },
		];

		for (const credential of credentials) {
			const option = authFlows
				.getLoginProviderOptions("api_key")
				.find((candidate) => candidate.id === credential.id);
			expect(option).toBeDefined();

			const login = authFlows.loginProvider(option!);
			const dialog = overlays.at(-1);
			expect(dialog).toBeDefined();
			for (const character of credential.key) {
				dialog?.handleInput?.(character);
			}
			dialog?.handleInput?.("\r");

			await expect(login).resolves.toMatchObject({
				status: "success",
				providerId: credential.id,
				authType: "api_key",
			});
			await expect(authStorage.getApiKey(credential.id)).resolves.toBe(credential.key);
		}

		expect(statusMessages).toEqual([
			expect.stringContaining("Saved API key for ClinePass"),
			expect.stringContaining("Saved API key for Meta Model API"),
			expect.stringContaining("Saved API key for Alibaba Cloud Model Studio Token Plan"),
		]);
	});

	it("shows all three providers in the API-key login selector", () => {
		const authFlows = new ProviderAuthFlows({
			ui: {} as TUI,
			modelRegistry,
			showStatus: () => {},
			showError: () => {},
			getAvailableModels: async () => [],
		});

		const options = authFlows.getLoginProviderOptions("api_key");
		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "cline-pass", name: "ClinePass", authType: "api_key" }),
				expect.objectContaining({ id: "meta", name: "Meta Model API", authType: "api_key" }),
				expect.objectContaining({
					id: "alibaba-token-plan",
					name: "Alibaba Cloud Model Studio Token Plan",
					authType: "api_key",
				}),
			]),
		);
	});
});

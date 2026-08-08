import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAICodex, refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";
import type { OAuthLoginError } from "../src/utils/oauth/types.js";

const fetchFromNetwork = globalThis.fetch.bind(globalThis);

function accessToken(): string {
	const payload = btoa(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-id" },
		}),
	);
	return `e30.${payload}.signature`;
}

function tokenResponse(): Response {
	return new Response(
		JSON.stringify({ access_token: accessToken(), refresh_token: "refresh-token", expires_in: 3600 }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe.sequential("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "authorization error",
			query: (state: string) => `error=access_denied&state=${encodeURIComponent(state)}`,
			code: "authorization_error",
		},
		{
			name: "missing code",
			query: (state: string) => `state=${encodeURIComponent(state)}`,
			code: "invalid_callback",
		},
		{
			name: "state mismatch",
			query: () => "code=browser-code&state=wrong-state",
			code: "state_mismatch",
		},
	])("settles the $name browser callback with a typed error", async ({ query, code }) => {
		let callbackRequest: Promise<Response> | undefined;
		const loginPromise = loginOpenAICodex({
			onAuth: ({ url }) => {
				const state = new URL(url).searchParams.get("state") ?? "";
				callbackRequest = fetchFromNetwork(`http://127.0.0.1:1455/auth/callback?${query(state)}`);
			},
			onPrompt: async () => "",
			onManualCodeInput: () => new Promise<string>(() => {}),
		});

		await expect(loginPromise).rejects.toMatchObject({
			name: "OAuthLoginError",
			code,
			source: "browser",
		});
		expect((await callbackRequest)?.status).toBe(400);
	});

	it("exchanges a manual result", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit): Promise<Response> => tokenResponse());
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginOpenAICodex({
			onAuth: ({ url }) => {
				authUrl = url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `manual-code#${state}`;
			},
		});

		expect(credentials.accountId).toBe("account-id");
		const params = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(params.get("code")).toBe("manual-code");
	});

	it("settles a manual authorization error with a typed error", async () => {
		let authUrl = "";
		const loginPromise = loginOpenAICodex({
			onAuth: ({ url }) => {
				authUrl = url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `http://localhost:1455/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`;
			},
		});

		await expect(loginPromise).rejects.toMatchObject({
			code: "authorization_error",
			source: "manual",
		});
	});

	it("uses the browser result when it settles before manual input", async () => {
		let callbackRequest: Promise<Response> | undefined;
		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit): Promise<Response> => tokenResponse());
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginOpenAICodex({
			onAuth: ({ url }) => {
				const state = new URL(url).searchParams.get("state") ?? "";
				callbackRequest = fetchFromNetwork(
					`http://127.0.0.1:1455/auth/callback?code=browser-code&state=${encodeURIComponent(state)}`,
				);
			},
			onPrompt: async () => "",
			onManualCodeInput: () => new Promise<string>(() => {}),
		});

		expect(credentials.accountId).toBe("account-id");
		expect((await callbackRequest)?.status).toBe(200);
		const params = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(params.get("code")).toBe("browser-code");
	});

	it("rejects with a typed error after the callback timeout", async () => {
		const onPrompt = vi.fn(async () => "unused");
		const loginPromise = loginOpenAICodex({
			onAuth: () => {},
			onPrompt,
			callbackTimeoutMs: 5,
		});

		await expect(loginPromise).rejects.toMatchObject({ code: "timeout", source: "timeout" });
		expect(onPrompt).not.toHaveBeenCalled();
	});

	it("rejects with a typed cancellation when aborted during the callback wait", async () => {
		const controller = new AbortController();
		const loginPromise = loginOpenAICodex({
			onAuth: () => controller.abort(),
			onPrompt: async () => "",
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toEqual(
			expect.objectContaining<Partial<OAuthLoginError>>({ code: "cancelled", source: "signal" }),
		);
	});
});

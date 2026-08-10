import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.js";
import { OAuthLoginError } from "../src/utils/oauth/types.js";

const fetchFromNetwork = globalThis.fetch.bind(globalThis);

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

async function occupyCallbackPort(port: number): Promise<Server | undefined> {
	const server = createServer();
	const bound = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => resolve(true));
	});
	return bound ? server : undefined;
}

async function closeServer(server: Server | undefined): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) {
					throw new Error("Missing OAuth state or redirect_uri in auth URL");
				}
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("settles a manual authorization error with a typed error", async () => {
		let authUrl = "";
		const loginPromise = loginAnthropic({
			onAuth: ({ url }) => {
				authUrl = url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state") ?? "";
				const redirectUri = url.searchParams.get("redirect_uri") ?? "";
				return `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`;
			},
		});

		await expect(loginPromise).rejects.toMatchObject({
			code: "authorization_error",
			source: "manual",
		});
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
		const loginPromise = loginAnthropic({
			onAuth: ({ url }) => {
				const authUrl = new URL(url);
				const state = authUrl.searchParams.get("state") ?? "";
				const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
				callbackRequest = fetchFromNetwork(`${redirectUri}?${query(state)}`);
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

	it("uses the browser result when it settles before manual input", async () => {
		let callbackRequest: Promise<Response> | undefined;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(getJsonBody(init).code).toBe("browser-code");
			return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginAnthropic({
			onAuth: ({ url }) => {
				const authUrl = new URL(url);
				const state = authUrl.searchParams.get("state") ?? "";
				const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
				callbackRequest = fetchFromNetwork(`${redirectUri}?code=browser-code&state=${encodeURIComponent(state)}`);
			},
			onPrompt: async () => "",
			onManualCodeInput: () => new Promise<string>(() => {}),
		});

		expect(credentials.access).toBe("access-token");
		expect((await callbackRequest)?.status).toBe(200);
	});

	it("rejects with a typed error after the callback timeout", async () => {
		const onPrompt = vi.fn(async () => "unused");
		const loginPromise = loginAnthropic({
			onAuth: () => {},
			onPrompt,
			callbackTimeoutMs: 5,
		});

		await expect(loginPromise).rejects.toMatchObject({ code: "timeout", source: "timeout" });
		expect(onPrompt).not.toHaveBeenCalled();
	});

	it("rejects with a typed cancellation when aborted during the callback wait", async () => {
		const controller = new AbortController();
		const loginPromise = loginAnthropic({
			onAuth: () => controller.abort(),
			onPrompt: async () => "",
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toEqual(
			expect.objectContaining<Partial<OAuthLoginError>>({ code: "cancelled", source: "signal" }),
		);
	});

	it("returns a typed callback-server error when the callback port is occupied", async () => {
		const blocker = await occupyCallbackPort(53692);
		try {
			const error = await loginAnthropic({ onAuth: () => {}, onPrompt: async () => "" }).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(OAuthLoginError);
			expect(error).toMatchObject({
				code: "callback_server_error",
				source: "server",
				cause: expect.objectContaining({ code: "EADDRINUSE" }),
			});
			expect((error as Error).message).toMatch(/EADDRINUSE|address already in use/i);
		} finally {
			await closeServer(blocker);
		}
	});

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshAnthropicToken("refresh-token");

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

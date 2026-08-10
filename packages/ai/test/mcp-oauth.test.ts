import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider } from "../src/mcp/oauth.js";
import { OAuthLoginError } from "../src/utils/oauth/types.js";

const fetchFromNetwork = globalThis.fetch.bind(globalThis);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

const META = {
	issuer: "https://srv.test",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
};

const CALLBACK_PORT_BASE = Number(process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700);

async function occupyCallbackPort(port: number): Promise<Server | undefined> {
	const server = createServer();
	const bound = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => resolve(true));
	});
	return bound ? server : undefined;
}

async function closeServers(servers: ReadonlyArray<Server | undefined>): Promise<void> {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					if (!server) {
						resolve();
						return;
					}
					server.close(() => resolve());
				}),
		),
	);
}

describe.sequential("MCP OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a namespaced id and label", () => {
		const provider = createMcpOAuthProvider({ server: "linear", label: "Linear", url: "https://srv.test/mcp" });
		expect(provider.id).toBe("mcp:linear");
		expect(provider.name).toBe("Linear");
		expect(provider.usesCallbackServer).toBe(true);
	});

	it("discovers, registers a client, and exchanges the code for tokens", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
			if (url === META.registration_endpoint) return jsonResponse({ client_id: "client-xyz" });
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("authorization_code");
				expect(params.get("client_id")).toBe("client-xyz");
				expect(params.get("code")).toBe("the-code");
				expect(params.get("code_verifier")).toBeTruthy();
				return jsonResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const creds = await provider.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			// Headless: supply the redirect URL via the manual-input path, which
			// races (and wins against) the local callback server.
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${REDIRECT}?code=the-code&state=${state}`;
			},
		});

		expect(creds.access).toBe("access-1");
		expect(creds.refresh).toBe("refresh-1");
		expect(creds.expires).toBeGreaterThan(Date.now());
		// auth URL carries PKCE challenge + registered client id
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("client-xyz");
		expect(authParams.get("code_challenge")).toBeTruthy();
		expect(authParams.get("scope")).toBe("read write");
	});

	it("falls back to the next port when the base callback port is in use", async () => {
		// Occupy the base callback port. If something already holds it (e.g. a stray
		// local daemon), that satisfies the precondition too — bind best-effort.
		const blocker = createServer();
		const blockerBound = await new Promise<boolean>((resolve) => {
			blocker.once("error", () => resolve(false));
			blocker.listen(CALLBACK_PORT_BASE, "127.0.0.1", () => resolve(true));
		});
		try {
			let authUrl = "";
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown): Promise<Response> => {
					const url = urlOf(input);
					if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
					if (url === META.registration_endpoint) return jsonResponse({ client_id: "c" });
					if (url === META.token_endpoint) return jsonResponse({ access_token: "a", expires_in: 60 });
					throw new Error(`unexpected fetch: ${url}`);
				}),
			);
			const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
			const creds = await provider.login({
				onAuth: (info) => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => {
					const p = new URL(authUrl).searchParams;
					return `${p.get("redirect_uri")}?code=x&state=${p.get("state")}`;
				},
			});
			expect(creds.access).toBe("a");
			// Did NOT use the blocked base port.
			const redirect = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
			const redirectPort = Number(new URL(redirect).port);
			expect(redirectPort).toBeGreaterThan(CALLBACK_PORT_BASE);
			expect(redirectPort).toBeLessThan(CALLBACK_PORT_BASE + 10);
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
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
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		let callbackRequest: Promise<Response> | undefined;
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", clientId: "client" });
		const loginPromise = provider.login({
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
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				if (url === META.token_endpoint) {
					expect(new URLSearchParams(String(init?.body)).get("code")).toBe("browser-code");
					return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", clientId: "client" });

		const credentials = await provider.login({
			onAuth: ({ url }) => {
				const authUrl = new URL(url);
				const state = authUrl.searchParams.get("state") ?? "";
				const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
				callbackRequest = fetchFromNetwork(`${redirectUri}?code=browser-code&state=${encodeURIComponent(state)}`);
			},
			onPrompt: async () => "",
			onManualCodeInput: () => new Promise<string>(() => {}),
		});

		expect(credentials.access).toBe("access");
		expect((await callbackRequest)?.status).toBe(200);
	});

	it("settles a manual authorization error with a typed error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		let authUrl = "";
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", clientId: "client" });
		const loginPromise = provider.login({
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

	it("rejects with a typed error after the callback timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const onPrompt = vi.fn(async () => "unused");
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", clientId: "client" });
		const loginPromise = provider.login({ onAuth: () => {}, onPrompt, callbackTimeoutMs: 5 });

		await expect(loginPromise).rejects.toMatchObject({ code: "timeout", source: "timeout" });
		expect(onPrompt).not.toHaveBeenCalled();
	});

	it("rejects with a typed cancellation when aborted during the callback wait", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const controller = new AbortController();
		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp", clientId: "client" });
		const loginPromise = provider.login({
			onAuth: () => controller.abort(),
			onPrompt: async () => "",
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toEqual(
			expect.objectContaining<Partial<OAuthLoginError>>({ code: "cancelled", source: "signal" }),
		);
	});

	it("returns a typed callback-server error when every callback port is occupied", async () => {
		const blockers = await Promise.all(
			Array.from({ length: 10 }, (_, index) => occupyCallbackPort(CALLBACK_PORT_BASE + index)),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(META);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		try {
			const provider = createMcpOAuthProvider({
				server: "demo",
				url: "https://srv.test/mcp",
				clientId: "client",
			});
			const error = await provider.login({ onAuth: () => {}, onPrompt: async () => "" }).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(OAuthLoginError);
			expect(error).toMatchObject({
				code: "callback_server_error",
				source: "server",
				cause: expect.objectContaining({ code: "EADDRINUSE" }),
			});
			expect((error as Error).message).toMatch(/ports .* are all in use/i);
		} finally {
			await closeServers(blockers);
		}
	});

	it("refreshes tokens, keeping the prior refresh token when omitted", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			if (url === META.token_endpoint) {
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				return jsonResponse({ access_token: "access-2", expires_in: 1800 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = createMcpOAuthProvider({ server: "demo", url: "https://srv.test/mcp" });
		const refreshed = await provider.refreshToken({
			access: "access-1",
			refresh: "old-refresh",
			expires: Date.now() - 1000,
			tokenEndpoint: META.token_endpoint,
			clientId: "client-xyz",
		} as never);

		expect(refreshed.access).toBe("access-2");
		expect(refreshed.refresh).toBe("old-refresh");
	});

	it("fails clearly when DCR is unavailable and no clientId is set", async () => {
		const noReg = { ...META, registration_endpoint: undefined };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = urlOf(input);
				if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(noReg);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = createMcpOAuthProvider({ server: "slackish", url: "https://srv.test/mcp" });
		await expect(provider.login({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(
			"dynamic client registration",
		);
	});
});

const REDIRECT = `http://localhost:${CALLBACK_PORT_BASE}/callback`;

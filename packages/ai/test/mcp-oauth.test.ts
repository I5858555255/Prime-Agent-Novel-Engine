import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuthProvider } from "../src/mcp/oauth.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

/** Serves the listed documents and 404s everything else, the way a real host does. */
function stubDiscoveryFetch(routes: Record<string, unknown>): { requested: string[] } {
	const requested: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown): Promise<Response> => {
			const url = urlOf(input);
			requested.push(url);
			const body = routes[url];
			return body === undefined ? jsonResponse({ error: "not_found" }, 404) : jsonResponse(body);
		}),
	);
	return { requested };
}

async function loginHeadless(provider: ReturnType<typeof createMcpOAuthProvider>) {
	let authUrl = "";
	const creds = await provider.login({
		onAuth: (info) => {
			authUrl = info.url;
		},
		onPrompt: async () => "",
		onManualCodeInput: async () => {
			const params = new URL(authUrl).searchParams;
			return `${params.get("redirect_uri")}?code=the-code&state=${params.get("state")}`;
		},
	});
	return { creds, authUrl };
}

const META = {
	issuer: "https://srv.test",
	authorization_endpoint: "https://srv.test/authorize",
	token_endpoint: "https://srv.test/token",
	registration_endpoint: "https://srv.test/register",
	scopes_supported: ["read", "write"],
};

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
		const http = await import("node:http");
		// Occupy the base callback port. If something already holds it (e.g. a stray
		// local daemon), that satisfies the precondition too — bind best-effort.
		const blocker = http.createServer();
		const blockerBound = await new Promise<boolean>((resolve) => {
			blocker.once("error", () => resolve(false));
			blocker.listen(53700, "127.0.0.1", () => resolve(true));
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
			expect(redirect).not.toContain(":53700/");
			expect(redirect).toContain(":5370");
		} finally {
			if (blockerBound) await new Promise<void>((resolve) => blocker.close(() => resolve()));
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

	// The MCP endpoint host publishes no authorization-server document; the authorization
	// server lives on another host and is only reachable through RFC 9728 metadata.
	it("resolves the authorization server from protected-resource metadata", async () => {
		const as = {
			issuer: "https://todoist.test",
			authorization_endpoint: "https://todoist.test/oauth/authorize",
			token_endpoint: "https://todoist.test/oauth/token",
			registration_endpoint: "https://todoist.test/oauth/register",
		};
		const { requested } = stubDiscoveryFetch({
			"https://ai.todoist.test/.well-known/oauth-protected-resource/mcp": {
				resource: "https://ai.todoist.test/mcp",
				authorization_servers: ["https://todoist.test"],
			},
			"https://todoist.test/.well-known/oauth-authorization-server": as,
			// The endpoint origin also answers, so the assertions below pin precedence
			// rather than merely proving the origin probe failed.
			"https://ai.todoist.test/.well-known/oauth-authorization-server": {
				issuer: "https://ai.todoist.test",
				authorization_endpoint: "https://ai.todoist.test/stale/authorize",
				token_endpoint: "https://ai.todoist.test/stale/token",
				registration_endpoint: "https://ai.todoist.test/stale/register",
			},
			[as.registration_endpoint]: { client_id: "todoist-client" },
			[as.token_endpoint]: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 },
		});

		const provider = createMcpOAuthProvider({ server: "todoist", url: "https://ai.todoist.test/mcp" });
		const { creds, authUrl } = await loginHeadless(provider);

		expect(creds.access).toBe("access-1");
		expect(requested).toContain("https://ai.todoist.test/.well-known/oauth-protected-resource/mcp");
		expect(new URL(authUrl).origin).toBe("https://todoist.test");
	});

	// RFC 8414 inserts the well-known segment between host and path, so an issuer of
	// `https://host/oidc` publishes at `https://host/.well-known/...(/oidc)`, not `https://host/oidc/.well-known/...`.
	it("resolves an issuer that carries a path", async () => {
		const as = {
			issuer: "https://auth.ashby.test/oidc",
			authorization_endpoint: "https://auth.ashby.test/oidc/authorize",
			token_endpoint: "https://auth.ashby.test/oidc/token",
			registration_endpoint: "https://auth.ashby.test/oidc/register",
		};
		const { requested } = stubDiscoveryFetch({
			"https://mcp.ashby.test/.well-known/oauth-protected-resource/mcp/v1": {
				authorization_servers: ["https://auth.ashby.test/oidc"],
			},
			"https://auth.ashby.test/.well-known/oauth-authorization-server/oidc": as,
			[as.registration_endpoint]: { client_id: "ashby-client" },
			[as.token_endpoint]: { access_token: "access-2", expires_in: 3600 },
		});

		const provider = createMcpOAuthProvider({ server: "ashby", url: "https://mcp.ashby.test/mcp/v1" });
		const { creds } = await loginHeadless(provider);

		expect(creds.access).toBe("access-2");
		expect(requested).toContain("https://auth.ashby.test/.well-known/oauth-authorization-server/oidc");
	});

	// Some servers publish only at the bare well-known even though their endpoint carries a path.
	it("falls back to the bare protected-resource document when the path-suffixed one is absent", async () => {
		const as = {
			issuer: "https://ironclad.test",
			authorization_endpoint: "https://ironclad.test/authorize",
			token_endpoint: "https://ironclad.test/token",
			registration_endpoint: "https://ironclad.test/register",
		};
		const { requested } = stubDiscoveryFetch({
			"https://mcp.ironclad.test/.well-known/oauth-protected-resource": {
				authorization_servers: ["https://ironclad.test"],
			},
			"https://ironclad.test/.well-known/oauth-authorization-server": as,
			[as.registration_endpoint]: { client_id: "ironclad-client" },
			[as.token_endpoint]: { access_token: "access-4", expires_in: 3600 },
		});

		const provider = createMcpOAuthProvider({ server: "ironclad", url: "https://mcp.ironclad.test/mcp" });
		const { creds } = await loginHeadless(provider);

		expect(creds.access).toBe("access-4");
		expect(requested.slice(0, 2)).toEqual([
			"https://mcp.ironclad.test/.well-known/oauth-protected-resource/mcp",
			"https://mcp.ironclad.test/.well-known/oauth-protected-resource",
		]);
	});

	// An MCP URL without a path publishes at the bare well-known, and issuers are
	// commonly advertised with a trailing slash.
	it("handles a pathless endpoint and a trailing slash on the advertised issuer", async () => {
		const as = {
			issuer: "https://api.box.test",
			authorization_endpoint: "https://api.box.test/authorize",
			token_endpoint: "https://api.box.test/token",
			registration_endpoint: "https://api.box.test/register",
		};
		const { requested } = stubDiscoveryFetch({
			"https://mcp.box.test/.well-known/oauth-protected-resource": {
				authorization_servers: ["https://api.box.test/"],
			},
			"https://api.box.test/.well-known/oauth-authorization-server": as,
			[as.registration_endpoint]: { client_id: "box-client" },
			[as.token_endpoint]: { access_token: "access-3", expires_in: 3600 },
		});

		const provider = createMcpOAuthProvider({ server: "box", url: "https://mcp.box.test" });
		const { creds } = await loginHeadless(provider);

		expect(creds.access).toBe("access-3");
		expect(requested.filter((url) => url.includes("//.well-known"))).toEqual([]);
	});

	it("reports a non-JSON metadata document distinctly from a transport failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = urlOf(input);
				if (url === "https://portal.test/.well-known/oauth-authorization-server") {
					return new Response("<!doctype html><title>Sign in</title>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				}
				return jsonResponse({ error: "not_found" }, 404);
			}),
		);

		const provider = createMcpOAuthProvider({ server: "portal", url: "https://portal.test/mcp" });
		await expect(provider.login({ onAuth: () => {}, onPrompt: async () => "" })).rejects.toThrow(/non-JSON/);
	});
});

const REDIRECT = `http://localhost:${process.env.PI_MCP_OAUTH_CALLBACK_PORT || 53700}/callback`;

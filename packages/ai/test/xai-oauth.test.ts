import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.js";
import { loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/auth";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function discoveryResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		issuer: "https://auth.x.ai",
		authorization_endpoint: AUTHORIZE_URL,
		token_endpoint: TOKEN_URL,
		...overrides,
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getFormBody(init?: RequestInit): URLSearchParams {
	if (!(init?.body instanceof URLSearchParams)) {
		throw new Error(`Expected URLSearchParams request body, got ${typeof init?.body}`);
	}
	return init.body;
}

describe.sequential("xAI OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is registered as a built-in OAuth provider", () => {
		expect(getOAuthProvider("xai-oauth")).toBe(xaiOAuthProvider);
		expect(xaiOAuthProvider.usesCallbackServer).toBe(true);
		expect(xaiOAuthProvider.getApiKey({ access: "token", refresh: "r", expires: 0 })).toBe("token");
	});

	it("exchanges a pasted redirect URL using PKCE and the loopback redirect_uri", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			if (getUrl(input) === DISCOVERY_URL) return discoveryResponse();

			expect(getUrl(input)).toBe(TOKEN_URL);
			expect(init?.method).toBe("POST");
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("manual-code");
			expect(body.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
			expect(body.get("code_verifier")).toBeTruthy();
			return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await loginXai({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
				expect(url.searchParams.get("code_challenge_method")).toBe("S256");
				expect(url.searchParams.get("scope")).toContain("offline_access");
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
		expect(credentials.tokenEndpoint).toBe(TOKEN_URL);
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("rejects a manual redirect URL whose state does not match", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				expect(getUrl(input)).toBe(DISCOVERY_URL);
				return discoveryResponse();
			}),
		);

		await expect(
			loginXai({
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => "http://127.0.0.1:56121/callback?code=manual-code&state=other-state",
			}),
		).rejects.toThrow("OAuth state mismatch");
	});

	it("refuses discovery endpoints outside x.ai", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => discoveryResponse({ token_endpoint: "https://evil.example/token" })),
		);

		await expect(
			loginXai({ onAuth: () => {}, onPrompt: async () => "", onManualCodeInput: async () => "" }),
		).rejects.toThrow(/Refusing non-xAI OAuth token_endpoint/);
	});

	it("refreshes against the stored token endpoint without re-running discovery", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe(TOKEN_URL);
			const body = getFormBody(init);
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("refresh-token");
			expect(body.get("client_id")).toBeTruthy();
			return jsonResponse({ access_token: "new-access-token", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await refreshXaiToken({
			access: "old-access-token",
			refresh: "refresh-token",
			expires: 0,
			tokenEndpoint: TOKEN_URL,
		});

		expect(credentials.access).toBe("new-access-token");
		// xAI omits refresh_token on refresh when the existing one stays valid.
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("surfaces the OAuth error code when a refresh is rejected", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => jsonResponse({ error: "invalid_grant" }, 400)),
		);

		await expect(
			refreshXaiToken({ access: "a", refresh: "r", expires: 0, tokenEndpoint: TOKEN_URL }),
		).rejects.toThrow(/xAI token request failed \(400\): invalid_grant/);
	});
});

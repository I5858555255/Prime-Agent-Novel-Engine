import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";
import { loginXai, refreshXaiToken, xaiOAuthProvider } from "../src/utils/oauth/xai.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
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

describe("xAI SuperGrok OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("runs device login with pending and slow_down polling", async () => {
		vi.useFakeTimers();
		const tokenResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 7 }, 400),
			jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = getUrl(input);
				if (url.endsWith("/oauth2/device/code")) {
					const body = new URLSearchParams(String(init?.body));
					expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
					expect(body.get("scope")).toContain("grok-cli:access");
					return jsonResponse({
						device_code: "device",
						user_code: "ABCD-EFGH",
						verification_uri: "https://accounts.x.ai/oauth2/device",
						verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
						expires_in: 1800,
						interval: 5,
					});
				}
				if (url.endsWith("/oauth2/token")) {
					const response = tokenResponses.shift();
					if (!response) {
						throw new Error("Unexpected extra token poll");
					}
					return response;
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		let authUrl = "";
		const loginPromise = loginXai({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(7000);

		const credentials = await loginPromise;
		expect(authUrl).toContain("user_code=ABCD-EFGH");
		expect(credentials).toMatchObject({ access: "access", refresh: "refresh" });
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("rejects non-https verification URLs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					device_code: "device",
					user_code: "ABCD-EFGH",
					verification_uri: "http://evil.example/device",
					expires_in: 1800,
				}),
			),
		);
		await expect(
			loginXai({
				onAuth: () => {},
				onPrompt: async () => "",
			}),
		).rejects.toThrow("Untrusted verification URL");
	});

	it("refreshes access tokens and keeps an unrotated refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 3600 })),
		);
		const credentials = await refreshXaiToken({
			access: "old",
			refresh: "same-refresh",
			expires: 0,
		});
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("same-refresh");
		expect(xaiOAuthProvider.getApiKey(credentials)).toBe("new-access");
	});

	it("registers as a built-in OAuth provider", () => {
		resetOAuthProviders();
		expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
	});
});

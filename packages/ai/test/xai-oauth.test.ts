import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";
import {
	loginXai,
	pollXaiDeviceToken,
	refreshXaiToken,
	requestXaiDeviceCode,
	xaiOAuthProvider,
} from "../src/utils/oauth/xai.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("xAI SuperGrok OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("requests a device code with the public client and validates browser URLs", async () => {
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
			expect(body.get("scope")).toContain("grok-cli:access");
			expect(body.get("referrer")).toBe("pi");
			return jsonResponse({
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "https://accounts.x.ai/oauth2/device",
				verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
				expires_in: 1800,
				interval: 5,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await requestXaiDeviceCode();
		expect(result.verification_uri_complete).toContain("user_code=ABCD-EFGH");

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "file:///tmp/untrusted",
				expires_in: 1800,
			}),
		);
		await expect(requestXaiDeviceCode()).rejects.toThrow("Untrusted verification URL");
	});

	it("waits before polling and handles pending and slow_down responses", async () => {
		const responses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 7 }, 400),
			jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		];
		const fetchMock = vi.fn(async () => responses.shift() ?? jsonResponse({}, 500));
		vi.stubGlobal("fetch", fetchMock);
		let now = 0;
		const waits: number[] = [];

		const token = await pollXaiDeviceToken(
			{
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "https://accounts.x.ai/oauth2/device",
				expires_in: 60,
				interval: 5,
			},
			undefined,
			{
				now: () => now,
				sleep: async (ms) => {
					waits.push(ms);
					now += ms;
				},
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(waits).toEqual([5000, 5000, 7000]);
		expect(token.access_token).toBe("access");
	});

	it("shows the complete verification URL and returns credentials", async () => {
		const responses = [
			jsonResponse({
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "https://accounts.x.ai/oauth2/device",
				verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
				expires_in: 1800,
				interval: 1,
			}),
			jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => responses.shift() ?? jsonResponse({}, 500)),
		);
		let authUrl = "";

		const credentials = await loginXai(
			{
				onAuth: (info) => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
			},
			{ sleep: async () => {} },
		);

		expect(authUrl).toContain("user_code=ABCD-EFGH");
		expect(credentials).toMatchObject({ access: "access", refresh: "refresh" });
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("refreshes access tokens and preserves an unrotated refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "new-access", expires_in: 3600 })),
		);
		const credentials = await refreshXaiToken({ access: "old", refresh: "same-refresh", expires: 0 });
		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("same-refresh");
		expect(xaiOAuthProvider.getApiKey(credentials)).toBe("new-access");
	});

	it("is restored as a built-in OAuth provider", () => {
		resetOAuthProviders();
		expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
	});
});

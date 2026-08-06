import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.js";
import type { OAuthCredentials } from "../src/utils/oauth/types.js";
import { xaiOAuthProvider } from "../src/utils/oauth/xai.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported request input: ${String(input)}`);
}

function requestForm(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(String(init?.body));
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		device_code: "device-code",
		user_code: "ABCD-1234",
		verification_uri: "https://accounts.x.ai/oauth2/device",
		expires_in: 900,
		interval: 5,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 21_600,
		token_type: "Bearer",
		...overrides,
	};
}

type AuthInfo = { url: string; instructions?: string };

function loginXaiForTest(options: {
	onAuth: (info: AuthInfo) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	return xaiOAuthProvider.login({
		onAuth: options.onAuth,
		onPrompt: () => {
			throw new Error("Unexpected prompt");
		},
		signal: options.signal,
	});
}

function refreshXaiForTest(refreshToken: string): Promise<OAuthCredentials> {
	return xaiOAuthProvider.refreshToken({ access: "old-access", refresh: refreshToken, expires: 0 });
}

describe("xAI OAuth device flow", () => {
	it("registers xAI as a built-in OAuth provider", () => {
		expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("uses the device grant, delays polling, and handles pending and slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		const pollTimes: number[] = [];
		const tokenReplies = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse(tokenResponse()),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url === "https://auth.x.ai/oauth2/device/code") {
				const form = requestForm(init);
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
				expect(form.get("referrer")).toBe("pi");
				return jsonResponse(deviceCodeResponse());
			}
			if (url === "https://auth.x.ai/oauth2/token") {
				pollTimes.push(Date.now());
				const form = requestForm(init);
				expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
				expect(form.get("device_code")).toBe("device-code");
				const reply = tokenReplies.shift();
				if (!reply) throw new Error("Unexpected token poll");
				return reply;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const authInfo: AuthInfo[] = [];
		const loginPromise = loginXaiForTest({ onAuth: (info) => authInfo.push(info) });

		await vi.advanceTimersByTimeAsync(0);
		expect(authInfo).toEqual([
			{
				url: "https://accounts.x.ai/oauth2/device",
				instructions: "Open the link and enter code ABCD-1234.",
			},
		]);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10_000]);
		await vi.advanceTimersByTimeAsync(10_000);

		const credentials = await loginPromise;
		expect(pollTimes).toEqual([
			startTime.getTime() + 5000,
			startTime.getTime() + 10_000,
			startTime.getTime() + 20_000,
		]);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 20_000 + 21_600_000 - 300_000,
		});
	});

	it("falls back to the RFC default poll interval when the server reports interval 0", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		const pollTimes: number[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				if (requestUrl(input) === "https://auth.x.ai/oauth2/device/code") {
					return jsonResponse(deviceCodeResponse({ interval: 0 }));
				}
				pollTimes.push(Date.now());
				return jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = loginXaiForTest({ onAuth: () => {} });
		await vi.advanceTimersByTimeAsync(5000);
		await loginPromise;
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);
	});

	it("prefers verification_uri_complete when the server provides it", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) =>
				requestUrl(input) === "https://auth.x.ai/oauth2/device/code"
					? jsonResponse(
							deviceCodeResponse({
								verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
							}),
						)
					: jsonResponse(tokenResponse()),
			),
		);

		const authInfo: AuthInfo[] = [];
		const loginPromise = loginXaiForTest({ onAuth: (info) => authInfo.push(info) });
		await vi.advanceTimersByTimeAsync(5000);
		await loginPromise;
		expect(authInfo[0]?.url).toBe("https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
	});

	it.each([
		["verification_uri", "http://accounts.x.ai/oauth2/device"],
		["verification_uri", "file:///etc/passwd"],
		["verification_uri", "not a url"],
		["verification_uri_complete", "http://accounts.x.ai/oauth2/device?user_code=ABCD-1234"],
	])("rejects an unsafe %s value", async (field, value) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(deviceCodeResponse({ [field]: value }))),
		);
		await expect(loginXaiForTest({ onAuth: () => {} })).rejects.toThrow("Untrusted verification URI");
	});

	it("stops without polling after the device code expires", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => jsonResponse(deviceCodeResponse({ expires_in: 2, interval: 5 })));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginXaiForTest({ onAuth: () => {} });
		const assertion = expect(loginPromise).rejects.toThrow("xAI device code expired");
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(["access_denied", "authorization_denied"])(
		"fails when device authorization is denied: %s",
		async (error) => {
			vi.useFakeTimers();
			let requestCount = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					requestCount += 1;
					return requestCount === 1
						? jsonResponse(deviceCodeResponse({ interval: 1 }))
						: jsonResponse({ error }, 400);
				}),
			);

			const loginPromise = loginXaiForTest({ onAuth: () => {} });
			const assertion = expect(loginPromise).rejects.toThrow("xAI device authorization was denied");
			await vi.advanceTimersByTimeAsync(1000);
			await assertion;
		},
	);

	it("cancels while waiting for the first token poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => jsonResponse(deviceCodeResponse()));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginXaiForTest({
			onAuth: () => controller.abort(),
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes tokens and preserves an unrotated refresh token", async () => {
		let requestCount = 0;
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(requestUrl(input)).toBe("https://auth.x.ai/oauth2/token");
			const form = requestForm(init);
			expect(form.get("grant_type")).toBe("refresh_token");
			expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
			requestCount += 1;
			if (requestCount === 1) {
				expect(form.get("refresh_token")).toBe("old-refresh");
				return jsonResponse(tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }));
			}
			expect(form.get("refresh_token")).toBe("keep-refresh");
			return jsonResponse(tokenResponse({ access_token: "newer-access", refresh_token: undefined }));
		});
		vi.stubGlobal("fetch", fetchMock);

		const rotated = await refreshXaiForTest("old-refresh");
		const preserved = await refreshXaiForTest("keep-refresh");
		expect(rotated.refresh).toBe("new-refresh");
		expect(rotated.access).toBe("new-access");
		expect(preserved.refresh).toBe("keep-refresh");
		expect(preserved.access).toBe("newer-access");
		expect(xaiOAuthProvider.name).toBe("xAI (Grok/X subscription)");
		expect(xaiOAuthProvider.getApiKey(preserved)).toBe("newer-access");
	});

	it("assumes a one-hour lifetime when expires_in is missing", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-09T20:00:00Z");
		vi.setSystemTime(startTime);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ expires_in: undefined }))),
		);

		const credentials = await refreshXaiForTest("old-refresh");
		expect(credentials.expires).toBe(startTime.getTime() + 3_600_000 - 300_000);
	});

	it("rejects token responses with missing fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ access_token: undefined }))),
		);
		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow("Invalid xAI OAuth response field: access_token");
	});

	it("surfaces the upstream error code and description on refresh failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "refresh token revoked" }, 400)),
		);
		await expect(refreshXaiForTest("old-refresh")).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token revoked",
		);
	});
});

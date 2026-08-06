import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeDevinCliToken, loginDevin } from "../src/utils/oauth/devin.js";
import { getOAuthProvider } from "../src/utils/oauth/index.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Devin OAuth", () => {
	it("registers Devin as a built-in OAuth provider", () => {
		const provider = getOAuthProvider("devin");

		expect(provider?.name).toBe("Devin");
		expect(provider?.usesCallbackServer).toBe(true);
	});

	it("exchanges a callback code for a CLI token", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ token: "devin-jwt" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const token = await exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl);

		expect(token).toBe("devin-jwt");
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.devin.ai/auth/cli/token",
			expect.objectContaining({
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ code: "callback-code", code_verifier: "pkce-verifier" }),
			}),
		);
	});

	it("forwards cancellation to the token exchange request", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancel token exchange"));
		const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			init?.signal?.throwIfAborted();
			return new Response(JSON.stringify({ token: "unexpected" }));
		});

		await expect(
			exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl, controller.signal),
		).rejects.toThrow("cancel token exchange");
	});

	it("aborts the callback wait and releases the local server", async () => {
		const controller = new AbortController();
		const login = loginDevin({
			onAuth: () => controller.abort(),
			onPrompt: async () => "",
			signal: controller.signal,
		});

		await expect(login).rejects.toMatchObject({ name: "AbortError" });
	});

	it("reports callback receipt before exchanging the token", async () => {
		const progress: string[] = [];
		let progressAtExchange = "";
		const fetchImpl = vi.fn(async () => {
			progressAtExchange = progress.at(-1) ?? "";
			return new Response(JSON.stringify({ token: "devin-session-token" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchImpl);

		await loginDevin({
			onAuth: () => {},
			onPrompt: async () => "",
			onProgress: (message) => progress.push(message),
			onManualCodeInput: async () => "manual-code",
		});

		expect(progressAtExchange).toBe("Authorization received. Completing Devin login...");
	});

	it("completes through the localhost browser callback", async () => {
		const browserFetch = globalThis.fetch;
		let callbackResponse: Promise<Response> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ token: "browser-session-token" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);

		const credentials = await loginDevin({
			onAuth: ({ url }) => {
				const authorizationUrl = new URL(url);
				const callbackUrl = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
				callbackUrl.searchParams.set("code", "browser-code");
				callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
				callbackResponse = browserFetch(callbackUrl);
			},
			onPrompt: async () => "",
		});

		expect(callbackResponse).toBeDefined();
		const response = await callbackResponse!;
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Devin authentication complete");
		expect(credentials.access).toBe("browser-session-token");
	});

	it("completes the manual authorization-code flow", async () => {
		let authorizationUrl: string | undefined;
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ token: "devin-session-token" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchImpl);

		const credentials = await loginDevin({
			onAuth: ({ url }) => {
				authorizationUrl = url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => "manual-code",
		});

		expect(authorizationUrl).toBeDefined();
		const url = new URL(authorizationUrl!);
		expect(url.origin + url.pathname).toBe("https://app.devin.ai/auth/cli/continue");
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:59653/callback");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
		expect(url.searchParams.get("state")).toBeTruthy();
		expect(credentials).toMatchObject({
			access: "devin-session-token",
			refresh: "devin-session-token",
			apiEndpoint: "https://api.devin.ai",
			enterpriseUrl: "https://app.devin.ai",
		});
	});

	it("rejects an empty token response", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl)).rejects.toThrow(
			"Devin CLI token exchange returned an empty token",
		);
	});
});

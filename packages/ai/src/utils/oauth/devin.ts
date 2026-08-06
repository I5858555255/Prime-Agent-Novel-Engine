import type { createServer as createHttpServer } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TOKEN_PATH = "/auth/cli/token";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CallbackResult = { code: string; state: string };

interface CallbackServer {
	waitForCode(): Promise<CallbackResult>;
	close(): void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

/** Node 20-compatible equivalent of `Promise.withResolvers()`. */
function createDeferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createTokenExchangeSignal(parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });

	const timeout = setTimeout(
		() => controller.abort(new Error("Devin CLI token exchange timed out after 30 seconds")),
		TOKEN_EXCHANGE_TIMEOUT_MS,
	);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

function parseAuthorizationInput(input: string): CallbackResult {
	const trimmed = input.trim();
	try {
		const url = new URL(trimmed);
		return {
			code: url.searchParams.get("code") ?? "",
			state: url.searchParams.get("state") ?? "",
		};
	} catch {
		return { code: trimmed, state: "" };
	}
}

async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	// OAuth is imported by browser builds; load Node's callback server only when login runs.
	const { createServer } = (await import("node:http")) as { createServer: typeof createHttpServer };
	const callback = createDeferred<CallbackResult>();
	let callbackTimeout: NodeJS.Timeout | undefined;

	const server = createServer((request, response) => {
		try {
			const url = new URL(request.url ?? "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
			if (url.pathname !== CALLBACK_PATH) {
				response.statusCode = 404;
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const code = url.searchParams.get("code") ?? "";
			const state = url.searchParams.get("state") ?? "";
			if (!code || state !== expectedState) {
				response.statusCode = 400;
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.end(oauthErrorHtml(!code ? "Missing authorization code." : "OAuth state mismatch."));
				return;
			}

			response.statusCode = 200;
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(oauthSuccessHtml("Devin authentication complete. You can close this window."));
			callback.resolve({ code, state });
		} catch (error) {
			response.statusCode = 500;
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(oauthErrorHtml("Internal error while processing OAuth callback."));
			callback.reject(error instanceof Error ? error : new Error(String(error)));
		}
	});

	const listening = createDeferred<void>();
	server.once("error", listening.reject);
	server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
		listening.resolve(undefined);
	});
	await listening.promise;

	return {
		waitForCode: () => {
			const timeout = createDeferred<CallbackResult>();
			callbackTimeout = setTimeout(
				() => timeout.reject(new Error("Timed out waiting for Devin OAuth callback")),
				CALLBACK_TIMEOUT_MS,
			);
			return Promise.race([callback.promise, timeout.promise]);
		},
		close: () => {
			clearTimeout(callbackTimeout);
			server.close();
			server.closeIdleConnections();
		},
	};
}

export async function exchangeDevinCliToken(
	authorizationCode: string,
	codeVerifier: string,
	fetchImpl: FetchFunction = fetch,
	signal?: AbortSignal,
): Promise<string> {
	const boundedSignal = createTokenExchangeSignal(signal);
	try {
		const response = await fetchImpl(`${DEVIN_API_URL}${TOKEN_PATH}`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				code: authorizationCode,
				code_verifier: codeVerifier,
			}),
			signal: boundedSignal.signal,
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Devin CLI token exchange failed: ${response.status} ${error}`.trim());
		}

		const data = (await response.json()) as { token?: unknown };
		if (typeof data.token !== "string" || data.token.length === 0) {
			throw new Error("Devin CLI token exchange returned an empty token");
		}
		return data.token;
	} finally {
		boundedSignal.dispose();
	}
}

function getTokenExpiry(token: string): number {
	try {
		const [, payload] = token.split(".");
		if (payload) {
			const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
			if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
				return decoded.exp * 1000 - 5 * 60 * 1000;
			}
		}
	} catch {
		// Non-JWT session tokens use a conservative long-lived fallback.
	}
	return Date.now() + FALLBACK_EXPIRES_MS;
}

export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.signal?.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
	const server = await startCallbackServer(state);

	const params = new URLSearchParams({
		redirect_uri: redirectUri,
		state,
		prompt: "select_account",
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	callbacks.onAuth({
		url: `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`,
		instructions: "Sign in to Devin in your browser.",
	});
	callbacks.onProgress?.("Waiting for browser authentication...");

	let abortHandler: (() => void) | undefined;
	try {
		const attempts: Promise<CallbackResult>[] = [server.waitForCode()];
		if (callbacks.onManualCodeInput) {
			attempts.push(callbacks.onManualCodeInput().then(parseAuthorizationInput));
		}
		if (callbacks.signal) {
			const signal = callbacks.signal;
			const aborted = createDeferred<never>();
			abortHandler = () => {
				try {
					signal.throwIfAborted();
				} catch (error) {
					aborted.reject(error);
				}
			};
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
			attempts.push(aborted.promise);
		}

		const result = await Promise.race(attempts);
		if (!result.code) throw new Error("Devin OAuth callback did not include an authorization code");
		if (result.state && result.state !== state) throw new Error("Devin OAuth state mismatch");

		callbacks.onProgress?.("Authorization received. Completing Devin login...");
		const token = await exchangeDevinCliToken(result.code, verifier, fetch, callbacks.signal);
		return {
			access: token,
			refresh: token,
			expires: getTokenExpiry(token),
			apiEndpoint: DEVIN_API_URL,
			enterpriseUrl: DEVIN_WEBAPP_URL,
		};
	} finally {
		if (abortHandler) callbacks.signal?.removeEventListener("abort", abortHandler);
		server.close();
	}
}

export const devinOAuthProvider: OAuthProviderInterface = {
	id: "devin",
	name: "Devin",
	usesCallbackServer: true,

	login: loginDevin,

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return credentials;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

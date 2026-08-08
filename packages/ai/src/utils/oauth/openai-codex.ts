/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import {
	connectOAuthManualInput,
	createOAuthTerminalWaiter,
	type OAuthTerminalWaiter,
	toOAuthLoginError,
} from "./terminal-waiter.js";
import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	OAuthLoginError,
	type OAuthLoginErrorSource,
	type OAuthPrompt,
	type OAuthProviderInterface,
} from "./types.js";

const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

function createState(): string {
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string; error?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			error: url.searchParams.get("error") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
			error: params.get("error") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = atob(payload);
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return {
			type: "failed",
			status: response.status,
			message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
		};
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		return {
			type: "failed",
			message: `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`,
		};
	}

	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				type: "failed",
				status: response.status,
				message: `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`,
			};
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
			return {
				type: "failed",
				message: `OpenAI Codex token refresh response missing fields: ${JSON.stringify(json)}`,
			};
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
	} catch (error) {
		return {
			type: "failed",
			message: `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

type OAuthCode = { code: string };

type OAuthServerInfo =
	| {
			available: true;
			close: () => void;
			waiter: OAuthTerminalWaiter<OAuthCode>;
	  }
	| {
			available: false;
			close: () => void;
	  };

function startLocalOAuthServer(
	state: string,
	options?: { callbackTimeoutMs?: number; signal?: AbortSignal },
): Promise<OAuthServerInfo> {
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}

	let waiter: OAuthTerminalWaiter<OAuthCode> | undefined;
	let listening = false;

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("OpenAI authentication did not complete.", `Error: ${error}`));
				waiter?.fail(
					new OAuthLoginError("authorization_error", "browser", `OpenAI authorization failed: ${error}`),
				);
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				waiter?.fail(new OAuthLoginError("state_mismatch", "browser", "OAuth state mismatch"));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				waiter?.fail(new OAuthLoginError("invalid_callback", "browser", "Missing authorization code"));
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
			waiter?.succeed({ code });
		} catch (error) {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
			waiter?.fail(toOAuthLoginError(error, "invalid_callback", "browser"));
		}
	});

	return new Promise((resolve) => {
		server
			.listen(1455, CALLBACK_HOST, () => {
				listening = true;
				waiter = createOAuthTerminalWaiter<OAuthCode>({
					timeoutMs: options?.callbackTimeoutMs,
					signal: options?.signal,
				});
				resolve({
					available: true,
					close: () => server.close(),
					waiter,
				});
			})
			.on("error", (error: NodeJS.ErrnoException) => {
				if (listening) {
					waiter?.fail(toOAuthLoginError(error, "callback_server_error", "server"));
					return;
				}
				resolve({
					available: false,
					close: () => {
						try {
							server.close();
						} catch {
							// ignore
						}
					},
				});
			});
	});
}

function parseAuthorizationResult(input: string, state: string, source: OAuthLoginErrorSource): OAuthCode {
	const parsed = parseAuthorizationInput(input);
	if (parsed.error) {
		throw new OAuthLoginError("authorization_error", source, `OpenAI authorization failed: ${parsed.error}`);
	}
	if (parsed.state && parsed.state !== state) {
		throw new OAuthLoginError("state_mismatch", source, "OAuth state mismatch");
	}
	if (!parsed.code) {
		throw new OAuthLoginError("invalid_callback", source, "Missing authorization code");
	}
	return { code: parsed.code };
}

function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Login with OpenAI Codex OAuth
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback if no onManualCodeInput)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 *                                    Useful for showing paste input immediately alongside browser flow.
 * @param options.originator - OAuth originator parameter (defaults to "pi")
 */
export async function loginOpenAICodex(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	originator?: string;
	signal?: AbortSignal;
	callbackTimeoutMs?: number;
}): Promise<OAuthCredentials> {
	if (options.signal?.aborted) {
		throw new OAuthLoginError("cancelled", "signal", "Login cancelled");
	}
	const { verifier, state, url } = await createAuthorizationFlow(options.originator);
	const server = await startLocalOAuthServer(state, options);

	let code: string | undefined;
	try {
		options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

		if (server.available) {
			if (options.onManualCodeInput) {
				connectOAuthManualInput(server.waiter, options.onManualCodeInput, (input) =>
					parseAuthorizationResult(input, state, "manual"),
				);
			}
			code = (await server.waiter.wait()).code;
		} else {
			if (options.onManualCodeInput) {
				try {
					code = parseAuthorizationResult(await options.onManualCodeInput(), state, "manual").code;
				} catch (error) {
					throw toOAuthLoginError(error, "cancelled", "manual");
				}
			}
		}

		// Fallback to onPrompt if still no code
		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code (or full redirect URL):",
			});
			code = parseAuthorizationResult(input, state, "manual").code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		const tokenResult = await exchangeAuthorizationCode(code, verifier);
		if (tokenResult.type !== "success") {
			throw new Error(tokenResult.message);
		}

		const accountId = getAccountId(tokenResult.access);
		if (!accountId) {
			throw new Error("Failed to extract accountId from token");
		}

		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
			accountId,
		};
	} finally {
		if (server.available) {
			server.waiter.fail(new OAuthLoginError("cancelled", "server", "OAuth callback wait closed"));
		}
		server.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error(result.message);
	}

	const accountId = getAccountId(result.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
		accountId,
	};
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenAICodex({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
			callbackTimeoutMs: callbacks.callbackTimeoutMs,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

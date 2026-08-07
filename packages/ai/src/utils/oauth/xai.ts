/**
 * xAI Grok OAuth flow (SuperGrok / X Premium subscriptions)
 *
 * Authorization code + PKCE against the xAI OIDC issuer, with a loopback
 * callback server. Endpoints come from OIDC discovery and are pinned to the
 * xAI origin so a tampered discovery document cannot redirect the token
 * exchange elsewhere.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback
 * server. It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type XaiCredentials = OAuthCredentials & {
	tokenEndpoint?: string;
};

type XaiDiscovery = {
	authorizationEndpoint: string;
	tokenEndpoint: string;
};

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
/** Refresh five minutes before the token actually expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("xAI OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

/** Reject any endpoint that discovery points outside of x.ai. */
function validateEndpoint(value: unknown, field: string): string {
	const raw = typeof value === "string" ? value : "";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`xAI OAuth discovery returned an invalid ${field}: ${raw}`);
	}
	if (url.protocol !== "https:" || (url.hostname !== "x.ai" && !url.hostname.endsWith(".x.ai"))) {
		throw new Error(`Refusing non-xAI OAuth ${field}: ${raw}`);
	}
	return url.toString();
}

async function discover(): Promise<XaiDiscovery> {
	const response = await fetch(DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`xAI OIDC discovery failed (${response.status}): ${text || response.statusText}`);
	}
	const payload = (await response.json()) as { authorization_endpoint?: unknown; token_endpoint?: unknown };
	return {
		authorizationEndpoint: validateEndpoint(payload.authorization_endpoint, "authorization_endpoint"),
		tokenEndpoint: validateEndpoint(payload.token_endpoint, "token_endpoint"),
	};
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("xAI authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(body),
		signal: AbortSignal.timeout(30_000),
	});

	const text = await response.text();

	if (!response.ok) {
		let oauthError = "";
		try {
			oauthError = String((JSON.parse(text) as { error?: unknown }).error ?? "");
		} catch {
			// non-JSON error body
		}
		throw new Error(`xAI token request failed (${response.status}): ${oauthError || text || response.statusText}`);
	}

	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`xAI token request returned invalid JSON: ${text}`);
	}
}

function toCredentials(
	payload: Record<string, unknown>,
	tokenEndpoint: string,
	fallbackRefresh?: string,
): XaiCredentials {
	const access = typeof payload.access_token === "string" ? payload.access_token : "";
	if (!access) {
		throw new Error("xAI token response did not include an access_token");
	}
	const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : (fallbackRefresh ?? "");
	if (!refresh) {
		throw new Error("xAI token response did not include a refresh_token");
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in ?? 3600);
	return {
		access,
		refresh,
		expires: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000 - EXPIRY_SKEW_MS,
		tokenEndpoint,
	};
}

/**
 * Login with xAI OAuth (authorization code + PKCE).
 *
 * Requires a SuperGrok or X Premium subscription with Grok access; the
 * resulting token draws on the subscription instead of metered API credit.
 */
export async function loginXai(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
}): Promise<OAuthCredentials> {
	options.onProgress?.("Discovering xAI OAuth endpoints...");
	const discovery = await discover();
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer(verifier);

	let code: string | undefined;

	try {
		const authUrl = new URL(discovery.authorizationEndpoint);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", CLIENT_ID);
		authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
		authUrl.searchParams.set("scope", SCOPE);
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", verifier);

		options.onAuth({
			url: authUrl.toString(),
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualInput) {
				code = parseManualInput(manualInput, verifier);
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					code = parseManualInput(manualInput, verifier);
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: REDIRECT_URI,
			});
			code = parseManualInput(input, verifier);
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		const payload = await postForm(discovery.tokenEndpoint, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		});
		return toCredentials(payload, discovery.tokenEndpoint);
	} finally {
		server.server.close();
	}
}

function parseManualInput(input: string, expectedState: string): string | undefined {
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== expectedState) {
		throw new Error("OAuth state mismatch");
	}
	return parsed.code;
}

/**
 * Refresh xAI OAuth token.
 *
 * Reuses the token endpoint captured at login so the common path needs no
 * discovery round trip; credentials stored before that field existed fall
 * back to discovery.
 */
export async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const creds = credentials as XaiCredentials;
	const tokenEndpoint = creds.tokenEndpoint
		? validateEndpoint(creds.tokenEndpoint, "token_endpoint")
		: (await discover()).tokenEndpoint;

	const payload = await postForm(tokenEndpoint, {
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: creds.refresh,
	});
	return toCredentials(payload, tokenEndpoint, creds.refresh);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai-oauth",
	name: "xAI Grok (SuperGrok/X Premium)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXai({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

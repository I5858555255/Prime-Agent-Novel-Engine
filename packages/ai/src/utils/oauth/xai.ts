/**
 * xAI SuperGrok OAuth device flow.
 *
 * This uses xAI's public Grok CLI OAuth client and RFC 8628 device authorization,
 * so login works in local and headless environments without a callback server.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
const DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface XaiOAuthOptions {
	tokenUrl?: string;
	deviceAuthorizationUrl?: string;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
}

export interface XaiDeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface XaiTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

interface XaiTokenErrorResponse {
	error?: string;
	error_description?: string;
	interval?: number;
}

function authHeaders(): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
		"User-Agent": "prime-agent",
	};
}

function positiveSecondsToMs(value: unknown, fallbackMs: number): number {
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function readError(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	return body ? `: ${body}` : "";
}

function validateVerificationUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Untrusted verification URL in xAI OAuth response");
	}
	if (url.protocol !== "https:") {
		throw new Error("Untrusted verification URL in xAI OAuth response");
	}
	return url.href;
}

export async function requestXaiDeviceCode(
	options: XaiOAuthOptions = {},
	signal?: AbortSignal,
): Promise<XaiDeviceCodeResponse> {
	const response = await fetch(options.deviceAuthorizationUrl ?? DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: authHeaders(),
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: SCOPE,
			referrer: "pi",
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`xAI device code request failed (${response.status})${await readError(response)}`);
	}

	const result = (await response.json()) as Partial<XaiDeviceCodeResponse>;
	if (!result.device_code || !result.user_code || !result.verification_uri) {
		throw new Error("xAI device code response is missing required fields");
	}
	return {
		...result,
		device_code: result.device_code,
		user_code: result.user_code,
		verification_uri: validateVerificationUrl(result.verification_uri),
		verification_uri_complete: result.verification_uri_complete
			? validateVerificationUrl(result.verification_uri_complete)
			: undefined,
	};
}

export async function pollXaiDeviceToken(
	device: XaiDeviceCodeResponse,
	signal?: AbortSignal,
	options: XaiOAuthOptions = {},
): Promise<XaiTokenResponse> {
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const deadline = now() + positiveSecondsToMs(device.expires_in, DEFAULT_EXPIRES_MS);
	let intervalMs = Math.max(positiveSecondsToMs(device.interval, DEFAULT_POLL_INTERVAL_MS), MIN_POLL_INTERVAL_MS);

	while (now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
		if (signal?.aborted) throw new Error("Login cancelled");

		const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
			method: "POST",
			headers: authHeaders(),
			body: new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: CLIENT_ID,
				device_code: device.device_code,
			}),
			signal,
		});

		if (response.ok) {
			const token = (await response.json()) as XaiTokenResponse;
			if (!token.access_token || !token.refresh_token) {
				throw new Error("xAI token response is missing access_token or refresh_token");
			}
			return token;
		}

		const body = (await response.json().catch(() => ({}))) as XaiTokenErrorResponse;
		if (body.error === "authorization_pending") {
			continue;
		}
		if (body.error === "slow_down") {
			intervalMs =
				typeof body.interval === "number" && body.interval > 0
					? body.interval * 1000
					: intervalMs + SLOW_DOWN_INCREMENT_MS;
			continue;
		}
		if (body.error === "access_denied" || body.error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (body.error === "expired_token") {
			throw new Error("xAI device code expired; run login again");
		}
		const detail = body.error_description ?? body.error ?? response.statusText;
		throw new Error(`xAI device token exchange failed (${response.status}): ${detail}`);
	}

	throw new Error("xAI device authorization timed out");
}

export async function refreshXaiToken(
	credentials: OAuthCredentials,
	options: XaiOAuthOptions = {},
): Promise<OAuthCredentials> {
	const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
		method: "POST",
		headers: authHeaders(),
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: CLIENT_ID,
		}),
	});

	if (!response.ok) {
		throw new Error(`xAI token refresh failed (${response.status})${await readError(response)}`);
	}

	const token = (await response.json()) as XaiTokenResponse;
	if (!token.access_token) {
		throw new Error("xAI token refresh response is missing access_token");
	}
	return {
		access: token.access_token,
		refresh: token.refresh_token ?? credentials.refresh,
		expires: Date.now() + positiveSecondsToMs(token.expires_in, 60 * 60 * 1000) - REFRESH_SKEW_MS,
	};
}

export async function loginXai(
	callbacks: OAuthLoginCallbacks,
	options: XaiOAuthOptions = {},
): Promise<OAuthCredentials> {
	const device = await requestXaiDeviceCode(options, callbacks.signal);
	callbacks.onAuth({
		url: device.verification_uri_complete ?? device.verification_uri,
		instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
	});
	callbacks.onProgress?.("Waiting for xAI authorization...");
	const token = await pollXaiDeviceToken(device, callbacks.signal, options);
	return {
		access: token.access_token as string,
		refresh: token.refresh_token as string,
		expires: Date.now() + positiveSecondsToMs(token.expires_in, 60 * 60 * 1000) - REFRESH_SKEW_MS,
	};
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI SuperGrok",
	login: loginXai,
	refreshToken: refreshXaiToken,
	getApiKey: (credentials) => credentials.access,
};

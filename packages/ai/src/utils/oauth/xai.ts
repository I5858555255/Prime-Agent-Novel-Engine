/**
 * xAI SuperGrok / X Premium OAuth device flow.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function formHeaders(): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	};
}

function expiresAt(expiresIn: number | undefined): number {
	const ttlMs = expiresIn && expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000;
	return Date.now() + ttlMs - 5 * 60 * 1000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function assertHttps(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") {
		throw new Error("Untrusted verification URL in xAI OAuth response");
	}
	return parsed.href;
}

export async function refreshXaiToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: formHeaders(),
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: CLIENT_ID,
		}),
	});
	if (!response.ok) {
		throw new Error(`xAI token refresh failed (${response.status})`);
	}
	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	if (!data.access_token) {
		throw new Error("xAI token refresh response is missing access_token");
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? credentials.refresh,
		expires: expiresAt(data.expires_in),
	};
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deviceResponse = await fetch(DEVICE_URL, {
		method: "POST",
		headers: formHeaders(),
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: SCOPE,
		}),
		signal: callbacks.signal,
	});
	if (!deviceResponse.ok) {
		throw new Error(`xAI device code request failed (${deviceResponse.status})`);
	}

	const device = (await deviceResponse.json()) as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
	};
	if (!device.device_code || !device.user_code || !device.verification_uri) {
		throw new Error("xAI device code response is missing required fields");
	}

	const verificationUri = assertHttps(device.verification_uri);
	callbacks.onAuth({
		url: device.verification_uri_complete ? assertHttps(device.verification_uri_complete) : verificationUri,
		instructions: `Open ${verificationUri} and enter code: ${device.user_code}`,
	});
	callbacks.onProgress?.("Waiting for xAI authorization...");

	const deadline =
		Date.now() + (device.expires_in && device.expires_in > 0 ? device.expires_in * 1000 : 30 * 60 * 1000);
	let intervalMs = Math.max((device.interval ?? 5) * 1000, 1000);

	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), callbacks.signal);

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: formHeaders(),
			body: new URLSearchParams({
				grant_type: DEVICE_GRANT,
				client_id: CLIENT_ID,
				device_code: device.device_code,
			}),
			signal: callbacks.signal,
		});
		const body = (await response.json().catch(() => ({}))) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
			interval?: number;
		};

		if (response.ok) {
			if (!body.access_token || !body.refresh_token) {
				throw new Error("xAI token response is missing access_token or refresh_token");
			}
			return {
				access: body.access_token,
				refresh: body.refresh_token,
				expires: expiresAt(body.expires_in),
			};
		}
		if (body.error === "authorization_pending") {
			continue;
		}
		if (body.error === "slow_down") {
			intervalMs = typeof body.interval === "number" && body.interval > 0 ? body.interval * 1000 : intervalMs + 5000;
			continue;
		}
		if (body.error === "access_denied" || body.error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (body.error === "expired_token") {
			throw new Error("xAI device code expired; run login again");
		}
		throw new Error(
			`xAI device token exchange failed (${response.status}): ${body.error_description ?? body.error ?? response.statusText}`,
		);
	}

	throw new Error("xAI device authorization timed out");
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI SuperGrok",
	login: loginXai,
	refreshToken: refreshXaiToken,
	getApiKey: (credentials) => credentials.access,
};

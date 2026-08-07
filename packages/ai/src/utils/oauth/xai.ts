/**
 * xAI OAuth device-code flow.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds: number;
	expiresInSeconds: number;
};

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function positiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	if (url.protocol !== "https:") {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	return url.href;
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<OAuthHttpResponse> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw error;
	}

	let body: JsonObject;
	try {
		const parsed = (await response.json()) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	return { ok: response.ok, status: response.status, body };
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	const loginHint =
		action === "token refresh" &&
		(error === "invalid_grant" || error === "invalid_token" || response.status === 401 || response.status === 403)
			? ". Run /login and sign in to xAI again."
			: "";
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}${loginHint}`);
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	const interval = body.interval;
	const intervalSeconds =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0
			? interval
			: DEFAULT_POLL_INTERVAL_SECONDS;
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? validateVerificationUri(body.verification_uri_complete)
			: undefined;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		verificationUriComplete,
		intervalSeconds,
		expiresInSeconds: positiveNumber(body, "expires_in"),
	};
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredentials {
	const access = requiredString(body, "access_token");
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token");
	const expiresInSeconds =
		body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in");
	return {
		access,
		refresh,
		expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			referrer: "pi",
		},
		signal,
	);
	if (!response.ok) throw requestFailure("device authorization", response);
	return parseDeviceCode(response.body);
}

async function pollForTokens(device: XaiDeviceCode, signal?: AbortSignal): Promise<OAuthCredentials> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalSeconds = device.intervalSeconds;

	while (Date.now() < deadline) {
		await abortableSleep(Math.min(intervalSeconds * 1000, deadline - Date.now()), signal);
		if (Date.now() >= deadline) break;
		const response = await postForm(
			XAI_TOKEN_URL,
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: XAI_CLIENT_ID,
				device_code: device.deviceCode,
			},
			signal,
		);

		if (response.ok) return credentialsFromTokenResponse(response.body);

		const error = response.body.error;
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			// RFC 8628 §3.5: interval MUST increase by at least 5 seconds on slow_down.
			// Honor a larger server-provided interval when present.
			const serverInterval = response.body.interval;
			const minIncreased = intervalSeconds + 5;
			intervalSeconds =
				typeof serverInterval === "number" && Number.isFinite(serverInterval) && serverInterval > 0
					? Math.max(serverInterval, minIncreased)
					: minIncreased;
			continue;
		}
		if (error === "access_denied" || error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (error === "expired_token") throw new Error("xAI device code expired");
		throw requestFailure("device token polling", response);
	}
	throw new Error("xAI device code expired");
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(callbacks.signal);
	callbacks.onAuth({
		url: device.verificationUriComplete ?? device.verificationUri,
		instructions: `Open the link and enter code ${device.userCode}.`,
	});
	callbacks.onProgress?.("Waiting for xAI authorization...");
	return pollForTokens(device, callbacks.signal);
}

export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await postForm(XAI_TOKEN_URL, {
		grant_type: "refresh_token",
		client_id: XAI_CLIENT_ID,
		refresh_token: refreshToken,
	});
	if (!response.ok) throw requestFailure("token refresh", response);
	return credentialsFromTokenResponse(response.body, refreshToken);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok/X subscription)",
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};

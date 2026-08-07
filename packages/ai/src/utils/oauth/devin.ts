import { loginDevin } from "widevin";
import type { OAuthProviderInterface } from "./types.js";

export const devinOAuthProvider: OAuthProviderInterface = {
	id: "devin",
	name: "Devin",

	async login(callbacks) {
		callbacks.signal?.throwIfAborted();
		callbacks.onProgress?.("Waiting for Devin authorization...");
		const token = await loginDevin({
			openBrowser: (url) => callbacks.onAuth({ url }),
		});
		callbacks.signal?.throwIfAborted();
		return {
			access: token,
			refresh: token,
			expires: Number.MAX_SAFE_INTEGER,
		};
	},

	async refreshToken(credentials) {
		return credentials;
	},

	getApiKey(credentials) {
		return credentials.access;
	},
};

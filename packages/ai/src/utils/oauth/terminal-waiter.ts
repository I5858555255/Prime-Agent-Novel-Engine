import { OAuthLoginError, type OAuthLoginErrorCode, type OAuthLoginErrorSource } from "./types.js";

export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthTerminalWaiter<T> {
	wait: () => Promise<T>;
	succeed: (value: T) => boolean;
	fail: (error: OAuthLoginError) => boolean;
}

export function toOAuthLoginError(
	error: unknown,
	code: OAuthLoginErrorCode,
	source: OAuthLoginErrorSource,
): OAuthLoginError {
	if (error instanceof OAuthLoginError) return error;
	return new OAuthLoginError(code, source, error instanceof Error ? error.message : String(error), { cause: error });
}

export function createOAuthTerminalWaiter<T>(options?: {
	timeoutMs?: number;
	signal?: AbortSignal;
}): OAuthTerminalWaiter<T> {
	const requestedTimeout = options?.timeoutMs ?? DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;
	const timeoutMs = Number.isFinite(requestedTimeout)
		? Math.max(1, requestedTimeout)
		: DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;
	let settled = false;
	let abortListenerAttached = false;
	let resolveWait: ((value: T) => void) | undefined;
	let rejectWait: ((error: OAuthLoginError) => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	const waitPromise = new Promise<T>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	void waitPromise.catch(() => {});

	const onAbort = () => {
		fail(new OAuthLoginError("cancelled", "signal", "Login cancelled"));
	};

	const cleanup = () => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		if (abortListenerAttached) {
			options?.signal?.removeEventListener("abort", onAbort);
			abortListenerAttached = false;
		}
	};

	const succeed = (value: T): boolean => {
		if (settled) return false;
		settled = true;
		cleanup();
		resolveWait?.(value);
		return true;
	};

	const fail = (error: OAuthLoginError): boolean => {
		if (settled) return false;
		settled = true;
		cleanup();
		rejectWait?.(error);
		return true;
	};

	if (options?.signal?.aborted) {
		fail(new OAuthLoginError("cancelled", "signal", "Login cancelled"));
	} else {
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		abortListenerAttached = options?.signal !== undefined;
		timeout = setTimeout(() => {
			fail(new OAuthLoginError("timeout", "timeout", "OAuth callback timed out"));
		}, timeoutMs);
	}

	return {
		wait: () => waitPromise,
		succeed,
		fail,
	};
}

export function connectOAuthManualInput<T>(
	waiter: OAuthTerminalWaiter<T>,
	readInput: () => Promise<string>,
	parseInput: (input: string) => T,
): void {
	let inputPromise: Promise<string>;
	try {
		inputPromise = readInput();
	} catch (error) {
		waiter.fail(toOAuthLoginError(error, "cancelled", "manual"));
		return;
	}

	void inputPromise.then(
		(input) => {
			try {
				waiter.succeed(parseInput(input));
			} catch (error) {
				waiter.fail(toOAuthLoginError(error, "invalid_callback", "manual"));
			}
		},
		(error) => {
			waiter.fail(toOAuthLoginError(error, "cancelled", "manual"));
		},
	);
}

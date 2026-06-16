/**
 * Token-authenticated TCP entrypoint for cloud agents (Prime Agent Swarm).
 *
 * The daemon's JSONL protocol normally rides a local unix socket. For a cloud
 * agent the daemon also listens on a TCP port that the platform exposes
 * publicly. TLS is terminated at the exposure edge, so inside the sandbox this
 * is plain TCP.
 *
 * Because the exposed port is public, every connection must authenticate by
 * sending the short-lived connect token the backend minted as its first line:
 *
 *     PRIME-AGENT-CONNECT <jwt>\n
 *
 * The token is an RS256 JWT (aud "prime-agent-daemon") verified with the public
 * key the backend ships into the sandbox. Verified sockets are handed to the
 * normal daemon connection handler unchanged — the transport stays raw JSONL,
 * so a future websocket transport can reuse `verifyConnectToken` and the same
 * handler without touching either.
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export const CONNECT_PREFIX = "PRIME-AGENT-CONNECT ";
export const CONNECT_TOKEN_AUDIENCE = "prime-agent-daemon";

const PREAMBLE_TIMEOUT_MS = 5_000;
const PREAMBLE_MAX_BYTES = 8 * 1024;

export interface ConnectListenerConfig {
	port: number;
	publicKey: string;
	agentId: string;
}

export interface ConnectTokenClaims {
	agent_id: string;
	sandbox_id?: string;
	user_id?: string;
	aud: string;
	exp: number;
	iat?: number;
}

/**
 * Build connect-listener config from the environment, or null when the daemon
 * is not a cloud agent (no shipped public key / agent id / daemon port).
 */
export function readConnectConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectListenerConfig | null {
	const port = Number(env.PRIME_AGENT_DAEMON_PORT);
	const publicKey = env.PRIME_AGENT_CONNECT_PUBLIC_KEY;
	const agentId = env.PRIME_AGENT_ID;
	if (!Number.isInteger(port) || port <= 0 || !publicKey || !agentId) {
		return null;
	}
	return { port, publicKey, agentId };
}

function base64UrlToBuffer(value: string): Buffer {
	return Buffer.from(value, "base64url");
}

/**
 * Verify a connect token. Returns the claims when valid for `agentId`, else
 * null. RS256 only — any other alg (including "none") is rejected.
 */
export function verifyConnectToken(
	token: string,
	options: { publicKey: string | KeyObject; agentId: string; now?: number },
): ConnectTokenClaims | null {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return null;
	}
	const [encodedHeader, encodedPayload, encodedSignature] = parts;

	let header: { alg?: string };
	let claims: ConnectTokenClaims;
	try {
		header = JSON.parse(base64UrlToBuffer(encodedHeader).toString("utf8"));
		claims = JSON.parse(base64UrlToBuffer(encodedPayload).toString("utf8"));
	} catch {
		return null;
	}
	// Reject anything that isn't RS256 (notably "none") before touching the key.
	if (header.alg !== "RS256") {
		return null;
	}

	let key: KeyObject;
	try {
		key = typeof options.publicKey === "string" ? createPublicKey(options.publicKey) : options.publicKey;
	} catch {
		return null;
	}

	const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
	try {
		if (!cryptoVerify("RSA-SHA256", signed, key, base64UrlToBuffer(encodedSignature))) {
			return null;
		}
	} catch {
		return null;
	}

	const now = options.now ?? Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== "number" || claims.exp <= now) {
		return null;
	}
	if (claims.aud !== CONNECT_TOKEN_AUDIENCE) {
		return null;
	}
	if (claims.agent_id !== options.agentId) {
		return null;
	}
	return claims;
}

/** Read the first newline-delimited line, bounded by size and time. */
function readPreambleLine(socket: Socket): Promise<{ line: string; rest: Buffer } | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;

		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			total += chunk.length;
			const buf = Buffer.concat(chunks);
			const newline = buf.indexOf(0x0a);
			if (newline !== -1) {
				let end = newline;
				if (end > 0 && buf[end - 1] === 0x0d) {
					end -= 1; // strip a trailing \r
				}
				finish({ line: buf.subarray(0, end).toString("utf8"), rest: buf.subarray(newline + 1) });
			} else if (total > PREAMBLE_MAX_BYTES) {
				finish(null);
			}
		};
		const onErrorOrClose = () => finish(null);
		const timer = setTimeout(() => finish(null), PREAMBLE_TIMEOUT_MS);
		timer.unref?.();

		function finish(result: { line: string; rest: Buffer } | null) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onErrorOrClose);
			socket.off("close", onErrorOrClose);
			resolve(result);
		}

		socket.on("data", onData);
		socket.on("error", onErrorOrClose);
		socket.on("close", onErrorOrClose);
	});
}

export class DaemonConnectListener {
	private server?: Server;

	constructor(
		private readonly config: ConnectListenerConfig,
		private readonly onAuthenticated: (socket: Socket) => void,
		private readonly deps: { log?: (message: string) => void } = {},
	) {}

	start(): void {
		if (this.server) {
			return;
		}
		this.server = createServer((socket) => void this.handleSocket(socket));
		this.server.on("error", (error) => this.deps.log?.(`listener error: ${error.message}`));
		this.server.listen(this.config.port, "0.0.0.0", () => {
			this.deps.log?.(`connect listener on :${this.config.port}`);
		});
	}

	stop(): void {
		this.server?.close();
		this.server = undefined;
	}

	/** Address the server actually bound (useful when started on port 0). */
	address() {
		return this.server?.address() ?? null;
	}

	private async handleSocket(socket: Socket): Promise<void> {
		const guard = () => socket.destroy();
		socket.on("error", guard);

		const preamble = await readPreambleLine(socket);
		if (!preamble || !preamble.line.startsWith(CONNECT_PREFIX)) {
			this.deps.log?.("rejected connection: missing or malformed preamble");
			socket.destroy();
			return;
		}

		const token = preamble.line.slice(CONNECT_PREFIX.length).trim();
		const claims = verifyConnectToken(token, {
			publicKey: this.config.publicKey,
			agentId: this.config.agentId,
		});
		if (!claims) {
			this.deps.log?.("rejected connection: invalid connect token");
			socket.destroy();
			return;
		}

		// Hand the authenticated socket to the normal daemon handler. Re-queue
		// any bytes that arrived after the preamble line so the JSONL reader
		// sees them.
		socket.off("error", guard);
		if (preamble.rest.length > 0) {
			socket.unshift(preamble.rest);
		}
		this.onAuthenticated(socket);
	}
}

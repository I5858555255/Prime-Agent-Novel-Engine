import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONNECT_PREFIX,
	type ConnectListenerConfig,
	DaemonConnectListener,
	readConnectConfigFromEnv,
	verifyConnectToken,
} from "../src/modes/daemon/connect-listener.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

function makeToken(claims: Record<string, unknown>, opts: { key?: KeyObject; alg?: string } = {}): string {
	const header = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify(claims));
	const signingInput = `${header}.${payload}`;
	const signature =
		opts.alg === "none" ? "" : b64url(cryptoSign("RSA-SHA256", Buffer.from(signingInput), opts.key ?? privateKey));
	return `${signingInput}.${signature}`;
}

const future = () => Math.floor(Date.now() / 1000) + 600;
const validClaims = () => ({ agent_id: "agent-1", sandbox_id: "sb-1", aud: "prime-agent-daemon", exp: future() });

describe("readConnectConfigFromEnv", () => {
	it("returns null without the cloud-agent env", () => {
		expect(readConnectConfigFromEnv({})).toBeNull();
		expect(readConnectConfigFromEnv({ PRIME_AGENT_DAEMON_PORT: "8000", PRIME_AGENT_ID: "a" })).toBeNull();
	});

	it("builds config when key, port and id are present", () => {
		const config = readConnectConfigFromEnv({
			PRIME_AGENT_DAEMON_PORT: "8000",
			PRIME_AGENT_ID: "agent-1",
			PRIME_AGENT_CONNECT_PUBLIC_KEY: PUBLIC_PEM,
		});
		expect(config).toEqual({ port: 8000, publicKey: PUBLIC_PEM, agentId: "agent-1" });
	});
});

describe("verifyConnectToken", () => {
	const verify = (token: string) => verifyConnectToken(token, { publicKey: PUBLIC_PEM, agentId: "agent-1" });

	it("accepts a valid token", () => {
		expect(verify(makeToken(validClaims()))?.agent_id).toBe("agent-1");
	});

	it("rejects a token signed by a different key", () => {
		const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
		expect(verify(makeToken(validClaims(), { key: other }))).toBeNull();
	});

	it("rejects alg=none", () => {
		expect(verify(makeToken(validClaims(), { alg: "none" }))).toBeNull();
	});

	it("rejects an expired token", () => {
		expect(verify(makeToken({ ...validClaims(), exp: Math.floor(Date.now() / 1000) - 5 }))).toBeNull();
	});

	it("rejects the wrong audience", () => {
		expect(verify(makeToken({ ...validClaims(), aud: "sandbox-gateway" }))).toBeNull();
	});

	it("rejects a token for a different agent", () => {
		expect(verify(makeToken({ ...validClaims(), agent_id: "agent-2" }))).toBeNull();
	});

	it("rejects malformed tokens", () => {
		expect(verify("not.a.token")).toBeNull();
		expect(verify("garbage")).toBeNull();
	});
});

describe("DaemonConnectListener", () => {
	let listener: DaemonConnectListener | undefined;
	const open: Socket[] = [];

	afterEach(() => {
		for (const s of open) s.destroy();
		open.length = 0;
		listener?.stop();
		listener = undefined;
	});

	function startListener(onAuthenticated: (socket: Socket) => void): Promise<number> {
		const config: ConnectListenerConfig = { port: 0, publicKey: PUBLIC_PEM, agentId: "agent-1" };
		listener = new DaemonConnectListener(config, onAuthenticated);
		listener.start();
		return new Promise((resolve, reject) => {
			let tries = 0;
			const poll = () => {
				const addr = listener?.address();
				if (addr && typeof addr === "object") return resolve(addr.port);
				if (tries++ > 50) return reject(new Error("listener did not bind"));
				setTimeout(poll, 10);
			};
			poll();
		});
	}

	it("hands a valid connection to the daemon handler with buffered bytes intact", async () => {
		const received: Buffer[] = [];
		const port = await startListener((socket) => {
			socket.on("data", (chunk) => received.push(chunk));
		});

		await new Promise<void>((resolve, reject) => {
			const client = connect(port, "127.0.0.1", () => {
				client.write(`${CONNECT_PREFIX}${makeToken(validClaims())}\n{"id":"1","type":"list"}\n`);
			});
			open.push(client);
			client.on("error", reject);
			const deadline = setTimeout(() => reject(new Error("no handoff")), 2000);
			const check = setInterval(() => {
				if (received.length > 0) {
					clearInterval(check);
					clearTimeout(deadline);
					resolve();
				}
			}, 10);
		});

		expect(Buffer.concat(received).toString("utf8")).toContain('"type":"list"');
	});

	it("drops a connection with an invalid token", async () => {
		let handed = false;
		const port = await startListener(() => {
			handed = true;
		});

		await new Promise<void>((resolve) => {
			const client = connect(port, "127.0.0.1", () => {
				client.write(`${CONNECT_PREFIX}bad.token.here\n`);
			});
			open.push(client);
			client.on("close", () => resolve());
			client.on("error", () => resolve());
		});

		expect(handed).toBe(false);
	});
});

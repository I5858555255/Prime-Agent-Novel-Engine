import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, VERSION } from "../config.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION } from "../modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";
import { formatDaemonListTable } from "./daemon-ps-format.js";

/**
 * `daemon ps` discovers every prime-agent daemon on the machine, not just the
 * one on a single socket. Discovery has two sources merged by socket path:
 *
 *  1. The OS list of listening unix sockets owned by a prime-agent process
 *     (`ss -lxp` on Linux, `lsof` on macOS). Daemons set process.title to
 *     APP_NAME and carry nothing useful in argv, so the socket→pid mapping the
 *     kernel keeps is the only reliable way to find daemons on arbitrary
 *     `--daemon-socket` paths. This is the same data as `ss -lxp | grep
 *     prime-agent`, just parsed.
 *  2. A sweep of the default socket dir, which catches orphaned socket *files*
 *     left behind by daemons that are no longer running.
 *
 * Each discovered socket is then probed with the existing daemon_hello + list
 * primitives, so introspection works even against stale daemons running an
 * older build (a new protocol command would not).
 */

export type DaemonStatus = "current" | "stale" | "unreachable" | "orphan-file";

export interface DiscoveredDaemonProcess {
	pid: number;
	socketPath: string;
	uptimeSeconds?: number;
}

export interface DaemonInfo {
	socketPath: string;
	pid?: number;
	uptimeSeconds?: number;
	version?: string;
	protocolVersion?: number;
	sessionCount?: number;
	status: DaemonStatus;
	isDefault: boolean;
}

const STATUS_ORDER: Record<DaemonStatus, number> = {
	current: 0,
	stale: 1,
	unreachable: 2,
	"orphan-file": 3,
};

// Linux comm names (and thus the process name ss reports) are capped at 15 chars.
const MAX_COMM_LENGTH = 15;

/** Normalize a socket path so process-scan and dir-sweep entries merge cleanly. */
function normalizeSocketPath(socketPath: string): string {
	if (process.platform === "win32") {
		return socketPath;
	}
	return resolve(socketPath);
}

function processNameMatches(name: string, appName: string): boolean {
	return name === appName || appName.slice(0, MAX_COMM_LENGTH) === name;
}

/** Parse `ss -lxp` output into the prime-agent daemons listening on unix sockets. */
export function parseSsListeners(stdout: string, appName: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] !== "LISTEN") {
			continue;
		}
		const socketPath = fields[4];
		if (!socketPath?.startsWith("/")) {
			continue;
		}
		const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
		if (!owner || !processNameMatches(owner[1]!, appName)) {
			continue;
		}
		daemons.push({ pid: Number.parseInt(owner[2]!, 10), socketPath: normalizeSocketPath(socketPath) });
	}
	return daemons;
}

/** Parse `lsof -nP -F pn -U -a -c <app>` output into listening unix socket owners (macOS fallback). */
export function parseLsofListeners(stdout: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	const seen = new Set<string>();
	let pid: number | undefined;
	for (const line of stdout.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = Number.parseInt(value, 10);
		} else if (field === "n" && pid !== undefined && value.startsWith("/")) {
			const socketPath = normalizeSocketPath(value);
			const key = `${pid}:${socketPath}`;
			if (!seen.has(key)) {
				seen.add(key);
				daemons.push({ pid, socketPath });
			}
		}
	}
	return daemons;
}

/** Parse `ps -o pid=,etimes=` output into a pid → uptime-seconds map. */
export function parsePsEtimes(stdout: string): Map<number, number> {
	const uptimes = new Map<number, number>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (match) {
			uptimes.set(Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10));
		}
	}
	return uptimes;
}

function scanListeningDaemons(): DiscoveredDaemonProcess[] {
	if (process.platform === "win32") {
		return [];
	}
	const ss = spawnSync("ss", ["-lxp"], { encoding: "utf8" });
	if (!ss.error && ss.status === 0 && typeof ss.stdout === "string") {
		return enrichUptimes(parseSsListeners(ss.stdout, APP_NAME));
	}
	const lsof = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-c", APP_NAME], { encoding: "utf8" });
	if (!lsof.error && typeof lsof.stdout === "string") {
		return enrichUptimes(parseLsofListeners(lsof.stdout));
	}
	return [];
}

function enrichUptimes(daemons: DiscoveredDaemonProcess[]): DiscoveredDaemonProcess[] {
	const pids = daemons.map((daemon) => daemon.pid);
	if (pids.length === 0) {
		return daemons;
	}
	const ps = spawnSync("ps", ["-o", "pid=,etimes=", "-p", pids.join(",")], { encoding: "utf8" });
	if (ps.error || typeof ps.stdout !== "string") {
		return daemons;
	}
	const uptimes = parsePsEtimes(ps.stdout);
	return daemons.map((daemon) => ({ ...daemon, uptimeSeconds: uptimes.get(daemon.pid) }));
}

/** Socket files in the default socket dir (may be live daemons or orphaned files). */
function scanSocketDir(): string[] {
	if (process.platform === "win32") {
		return [];
	}
	const dir = defaultDaemonSocketDir();
	if (!existsSync(dir)) {
		return [];
	}
	const sockets: string[] = [];
	for (const entry of readdirSync(dir)) {
		const socketPath = join(dir, entry);
		try {
			if (lstatSync(socketPath).isSocket()) {
				sockets.push(normalizeSocketPath(socketPath));
			}
		} catch {
			// Entry vanished between readdir and lstat; ignore.
		}
	}
	return sockets;
}

interface ProbeResult {
	version?: string;
	protocolVersion?: number;
	sessionCount?: number;
	reachable: boolean;
}

async function probeDaemon(socketPath: string): Promise<ProbeResult> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(300);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		let version: string | undefined;
		let protocolVersion: number | undefined;
		try {
			const hello = await client.waitForHello(1500);
			version = hello.appVersion;
			protocolVersion = hello.protocol.version;
		} catch {
			// Connected but no recognizable greeting: an old/foreign daemon.
		}
		let sessionCount: number | undefined;
		try {
			const response = await client.request({ type: "list" });
			if (response.success) {
				const sessions = (response.data as { sessions?: unknown })?.sessions;
				if (Array.isArray(sessions)) {
					sessionCount = sessions.length;
				}
			}
		} catch {
			// Leave sessionCount undefined when the daemon will not answer list.
		}
		return { version, protocolVersion, sessionCount, reachable: true };
	} finally {
		client.close();
	}
}

function classifyReachable(probe: ProbeResult): DaemonStatus {
	if (probe.protocolVersion === DAEMON_PROTOCOL_VERSION && probe.version === VERSION) {
		return "current";
	}
	return "stale";
}

/** Discover every daemon on the machine and probe each for version + session count. */
export async function discoverDaemons(): Promise<DaemonInfo[]> {
	const processBySocket = new Map<string, DiscoveredDaemonProcess>();
	for (const daemon of scanListeningDaemons()) {
		processBySocket.set(daemon.socketPath, daemon);
	}

	const sockets = new Set<string>([...processBySocket.keys(), ...scanSocketDir()]);
	const defaultSocket = normalizeSocketPath(defaultDaemonSocketPath());

	const infos = await Promise.all(
		[...sockets].map(async (socketPath): Promise<DaemonInfo> => {
			const proc = processBySocket.get(socketPath);
			const probe = await probeDaemon(socketPath);
			const status: DaemonStatus = probe.reachable ? classifyReachable(probe) : proc ? "unreachable" : "orphan-file";
			return {
				socketPath,
				pid: proc?.pid,
				uptimeSeconds: proc?.uptimeSeconds,
				version: probe.version,
				protocolVersion: probe.protocolVersion,
				sessionCount: probe.sessionCount,
				status,
				isDefault: socketPath === defaultSocket,
			};
		}),
	);

	return sortDaemons(infos);
}

export function sortDaemons(infos: DaemonInfo[]): DaemonInfo[] {
	return [...infos].sort((left, right) => {
		if (left.isDefault !== right.isDefault) {
			return left.isDefault ? -1 : 1;
		}
		const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		return statusDelta || left.socketPath.localeCompare(right.socketPath);
	});
}

export async function runPs(json: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	if (json) {
		console.log(JSON.stringify(daemons, null, 2));
		return;
	}
	if (daemons.length === 0) {
		console.log("No daemons found.");
		return;
	}
	console.log(formatDaemonListTable(daemons));
}

/**
 * Reap clearly-safe daemons: orphaned socket files, and reachable idle daemons
 * on non-default sockets. The user's default daemon and any daemon with live
 * sessions are never touched. Unreachable (hung) daemons are killed only with
 * `force`.
 */
export async function runReap(json: boolean, force: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	const reaped: Array<{ socketPath: string; action: string }> = [];
	const skipped: Array<{ socketPath: string; reason: string }> = [];

	for (const daemon of daemons) {
		if (daemon.isDefault) {
			skipped.push({ socketPath: daemon.socketPath, reason: "default daemon" });
			continue;
		}
		if (daemon.status === "orphan-file") {
			if (removeSocketFile(daemon.socketPath)) {
				reaped.push({ socketPath: daemon.socketPath, action: "removed stale socket file" });
			} else {
				skipped.push({ socketPath: daemon.socketPath, reason: "could not remove socket file" });
			}
			continue;
		}
		if (daemon.status === "unreachable") {
			if (force && daemon.pid !== undefined) {
				killDaemon(daemon.pid);
				removeSocketFile(daemon.socketPath);
				reaped.push({ socketPath: daemon.socketPath, action: `killed unreachable daemon (pid ${daemon.pid})` });
			} else {
				skipped.push({ socketPath: daemon.socketPath, reason: "unreachable; pass --force to kill" });
			}
			continue;
		}
		if (daemon.sessionCount !== 0) {
			skipped.push({ socketPath: daemon.socketPath, reason: `has ${daemon.sessionCount ?? "unknown"} session(s)` });
			continue;
		}
		const stopped = await shutdownDaemon(daemon.socketPath);
		if (stopped) {
			reaped.push({
				socketPath: daemon.socketPath,
				action: `stopped idle daemon${daemon.pid ? ` (pid ${daemon.pid})` : ""}`,
			});
		} else {
			skipped.push({ socketPath: daemon.socketPath, reason: "shutdown request failed" });
		}
	}

	if (json) {
		console.log(JSON.stringify({ reaped, skipped }, null, 2));
		return;
	}
	if (reaped.length === 0 && skipped.length === 0) {
		console.log("No daemons found.");
		return;
	}
	for (const entry of reaped) {
		console.log(chalk.green(`reaped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of skipped) {
		console.log(chalk.dim(`kept   ${entry.socketPath}: ${entry.reason}`));
	}
}

function removeSocketFile(socketPath: string): boolean {
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		return true;
	} catch {
		return false;
	}
}

function killDaemon(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process already gone or not permitted; the socket file cleanup still runs.
	}
}

async function shutdownDaemon(socketPath: string): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		await client.request({ type: "shutdown" }).catch(() => undefined);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

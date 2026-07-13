import { writeFileSync } from "node:fs";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	maybeRunOwnedSessionWorkerFrontend,
} from "../../src/cli/owned-session-worker.js";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.js";

const args = process.argv.slice(2);
const pidPath = process.env.PRIME_AGENT_TEST_OWNED_PID_PATH;
installOwnedSessionWorkerOwnerWatch();

if (process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER === "1") {
	if (pidPath) {
		writeFileSync(pidPath, `${process.pid}\n`);
		writeFileSync(`${pidPath}.ppid`, `${process.ppid}\n`);
		process.once("SIGTERM", () => {
			writeFileSync(`${pidPath}.terminated`, "terminated\n");
			process.exit(0);
		});
	}
	if (process.env.PRIME_AGENT_TEST_KEEP_ALIVE === "1") {
		setInterval(() => {}, 1000);
	}
	if (args.includes("--mode") && args.includes("rpc")) {
		attachJsonlLineReader(process.stdin, (line) => {
			const command = JSON.parse(line) as { id?: string; type: string };
			if (process.env.PRIME_AGENT_TEST_INVALID_RPC_OUTPUT === "1") {
				process.stdout.write("truncated-json\n");
				process.stdout.write("null\n");
			}
			process.stdout.write(
				serializeJsonLine({
					...(command.id ? { id: command.id } : {}),
					type: "response",
					command: command.type,
					success: true,
				}),
			);
		});
		process.stdin.once("end", closeOwnedSessionWorkerOwnerWatch);
		process.stdin.resume();
	} else {
		process.stdin.pipe(process.stdout);
		if (process.env.PRIME_AGENT_TEST_KEEP_ALIVE !== "1") {
			process.stdin.once("end", closeOwnedSessionWorkerOwnerWatch);
		}
	}
} else {
	if (pidPath) {
		writeFileSync(`${pidPath}.frontend`, `${process.pid}\n`);
	}
	await maybeRunOwnedSessionWorkerFrontend(args);
}

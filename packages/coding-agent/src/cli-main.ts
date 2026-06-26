import { enableCompileCache } from "node:module";
import { maybeStartInteractiveDaemonEarly } from "./cli/daemon-launch.js";
import { APP_NAME } from "./config.js";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Boot a cold daemon concurrently with this process's heavy imports.
	maybeStartInteractiveDaemonEarly(process.argv.slice(2));

	const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
		import("undici"),
		import("./main.js"),
	]);

	// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
	// SDKs enforce their own deadlines via retry.provider.timeoutMs.
	setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

	await main(process.argv.slice(2));
}

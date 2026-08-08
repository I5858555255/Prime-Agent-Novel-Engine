import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ProxyAgent } from "proxy-agent";

const BEDROCK_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

export function createBedrockNodeRequestHandler(env: NodeJS.ProcessEnv): NodeHttpHandler | undefined {
	if (BEDROCK_PROXY_ENV_KEYS.some((key) => env[key])) {
		const agent = new ProxyAgent();
		return new NodeHttpHandler({
			httpAgent: agent,
			httpsAgent: agent,
		});
	}

	if (env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
		return new NodeHttpHandler();
	}

	return undefined;
}

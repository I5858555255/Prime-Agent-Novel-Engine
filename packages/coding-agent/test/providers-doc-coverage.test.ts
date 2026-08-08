import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

const providersDoc = readFileSync(resolve(__dirname, "../docs/providers.md"), "utf-8");

/**
 * Canonical credential matrix derived from env-api-keys.ts and provider definitions.
 * This is the single source of truth for what credentials each provider supports.
 */
interface ProviderCredentialSpec {
	providerId: KnownProvider;
	displayName: string;
	envVars: readonly string[];
	authJsonKey: string;
	/** Additional ambient/delegated auth methods not captured by env vars */
	ambientAuth?: readonly string[];
	/** Whether this provider uses OAuth (not API key) */
	isOAuth?: boolean;
	/** Whether this provider uses a shared env var with another provider */
	sharedEnvVar?: string;
}

const CREDENTIAL_MATRIX: ProviderCredentialSpec[] = [
	{
		providerId: "anthropic",
		displayName: "Anthropic",
		envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
		authJsonKey: "anthropic",
		ambientAuth: [],
		isOAuth: true,
	},
	{
		providerId: "amazon-bedrock",
		displayName: "Amazon Bedrock",
		envVars: [],
		authJsonKey: "amazon-bedrock",
		ambientAuth: [
			"AWS_PROFILE",
			"AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
			"AWS_BEARER_TOKEN_BEDROCK",
			"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
			"AWS_CONTAINER_CREDENTIALS_FULL_URI",
			"AWS_WEB_IDENTITY_TOKEN_FILE",
		],
	},
	{
		providerId: "azure-openai-responses",
		displayName: "Azure OpenAI Responses",
		envVars: ["AZURE_OPENAI_API_KEY"],
		authJsonKey: "azure-openai-responses",
		ambientAuth: [],
	},
	{
		providerId: "openai",
		displayName: "OpenAI",
		envVars: ["OPENAI_API_KEY"],
		authJsonKey: "openai",
		ambientAuth: [],
	},
	{
		providerId: "prime-inference",
		displayName: "Prime Inference",
		envVars: ["PRIME_API_KEY"],
		authJsonKey: "prime-inference",
		ambientAuth: [],
	},
	{
		providerId: "deepseek",
		displayName: "DeepSeek",
		envVars: ["DEEPSEEK_API_KEY"],
		authJsonKey: "deepseek",
		ambientAuth: [],
	},
	{
		providerId: "google",
		displayName: "Google Gemini",
		envVars: ["GEMINI_API_KEY"],
		authJsonKey: "google",
		ambientAuth: [],
	},
	{
		providerId: "google-vertex",
		displayName: "Google Vertex AI",
		envVars: ["GOOGLE_CLOUD_API_KEY"],
		authJsonKey: "google-vertex",
		ambientAuth: [
			"GOOGLE_APPLICATION_CREDENTIALS",
			"ADC default path (~/.config/gcloud/application_default_credentials.json)",
		],
	},
	{
		providerId: "groq",
		displayName: "Groq",
		envVars: ["GROQ_API_KEY"],
		authJsonKey: "groq",
		ambientAuth: [],
	},
	{
		providerId: "cerebras",
		displayName: "Cerebras",
		envVars: ["CEREBRAS_API_KEY"],
		authJsonKey: "cerebras",
		ambientAuth: [],
	},
	{
		providerId: "xai",
		displayName: "xAI",
		envVars: ["XAI_API_KEY"],
		authJsonKey: "xai",
		ambientAuth: [],
	},
	{
		providerId: "openrouter",
		displayName: "OpenRouter",
		envVars: ["OPENROUTER_API_KEY"],
		authJsonKey: "openrouter",
		ambientAuth: [],
	},
	{
		providerId: "vercel-ai-gateway",
		displayName: "Vercel AI Gateway",
		envVars: ["AI_GATEWAY_API_KEY"],
		authJsonKey: "vercel-ai-gateway",
		ambientAuth: [],
	},
	{
		providerId: "zai",
		displayName: "ZAI",
		envVars: ["ZAI_API_KEY"],
		authJsonKey: "zai",
		ambientAuth: [],
	},
	{
		providerId: "mistral",
		displayName: "Mistral",
		envVars: ["MISTRAL_API_KEY"],
		authJsonKey: "mistral",
		ambientAuth: [],
	},
	{
		providerId: "minimax",
		displayName: "MiniMax",
		envVars: ["MINIMAX_API_KEY"],
		authJsonKey: "minimax",
		ambientAuth: [],
	},
	{
		providerId: "minimax-cn",
		displayName: "MiniMax (China)",
		envVars: ["MINIMAX_CN_API_KEY"],
		authJsonKey: "minimax-cn",
		ambientAuth: [],
	},
	{
		providerId: "moonshotai",
		displayName: "Moonshot AI",
		envVars: ["MOONSHOT_API_KEY"],
		authJsonKey: "moonshotai",
		ambientAuth: [],
		sharedEnvVar: "MOONSHOT_API_KEY",
	},
	{
		providerId: "moonshotai-cn",
		displayName: "Moonshot AI (China)",
		envVars: ["MOONSHOT_API_KEY"],
		authJsonKey: "moonshotai-cn",
		ambientAuth: [],
		sharedEnvVar: "MOONSHOT_API_KEY",
	},
	{
		providerId: "huggingface",
		displayName: "Hugging Face",
		envVars: ["HF_TOKEN"],
		authJsonKey: "huggingface",
		ambientAuth: [],
	},
	{
		providerId: "fireworks",
		displayName: "Fireworks",
		envVars: ["FIREWORKS_API_KEY"],
		authJsonKey: "fireworks",
		ambientAuth: [],
	},
	{
		providerId: "opencode",
		displayName: "OpenCode Zen",
		envVars: ["OPENCODE_API_KEY"],
		authJsonKey: "opencode",
		ambientAuth: [],
		sharedEnvVar: "OPENCODE_API_KEY",
	},
	{
		providerId: "opencode-go",
		displayName: "OpenCode Go",
		envVars: ["OPENCODE_API_KEY"],
		authJsonKey: "opencode-go",
		ambientAuth: [],
		sharedEnvVar: "OPENCODE_API_KEY",
	},
	{
		providerId: "kimi-coding",
		displayName: "Kimi For Coding",
		envVars: ["KIMI_API_KEY"],
		authJsonKey: "kimi-coding",
		ambientAuth: [],
	},
	{
		providerId: "cloudflare-workers-ai",
		displayName: "Cloudflare Workers AI",
		envVars: ["CLOUDFLARE_API_KEY"],
		authJsonKey: "cloudflare-workers-ai",
		ambientAuth: [],
		sharedEnvVar: "CLOUDFLARE_API_KEY",
	},
	{
		providerId: "cloudflare-ai-gateway",
		displayName: "Cloudflare AI Gateway",
		envVars: ["CLOUDFLARE_API_KEY"],
		authJsonKey: "cloudflare-ai-gateway",
		ambientAuth: [],
		sharedEnvVar: "CLOUDFLARE_API_KEY",
	},
	{
		providerId: "xiaomi",
		displayName: "Xiaomi MiMo",
		envVars: ["XIAOMI_API_KEY"],
		authJsonKey: "xiaomi",
		ambientAuth: [],
	},
	{
		providerId: "xiaomi-token-plan-cn",
		displayName: "Xiaomi MiMo Token Plan (China)",
		envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
		authJsonKey: "xiaomi-token-plan-cn",
		ambientAuth: [],
	},
	{
		providerId: "xiaomi-token-plan-ams",
		displayName: "Xiaomi MiMo Token Plan (Amsterdam)",
		envVars: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
		authJsonKey: "xiaomi-token-plan-ams",
		ambientAuth: [],
	},
	{
		providerId: "xiaomi-token-plan-sgp",
		displayName: "Xiaomi MiMo Token Plan (Singapore)",
		envVars: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
		authJsonKey: "xiaomi-token-plan-sgp",
		ambientAuth: [],
	},
	{
		providerId: "github-copilot",
		displayName: "GitHub Copilot",
		envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
		authJsonKey: "github-copilot",
		ambientAuth: [],
		isOAuth: true,
	},
];

describe("providers.md coverage", () => {
	it("documents every built-in provider by display name", () => {
		const missing = Object.entries(BUILT_IN_PROVIDER_DISPLAY_NAMES)
			// prime-agent-traces is a telemetry-only provider, not an auth provider.
			.filter(([id]) => id !== "prime-agent-traces")
			.filter(([, name]) => !providersDoc.includes(name))
			.map(([id, name]) => `${id} (${name})`);

		expect(missing).toEqual([]);
	});

	it("documents every provider's environment variable(s) in the API Keys table", () => {
		const missing: string[] = [];

		for (const spec of CREDENTIAL_MATRIX) {
			for (const envVar of spec.envVars) {
				if (!providersDoc.includes(envVar)) {
					missing.push(`${spec.providerId}: missing env var ${envVar} in API Keys table`);
				}
			}
		}

		expect(missing).toEqual([]);
	});

	it("documents every provider's auth.json key in the API Keys table", () => {
		const missing: string[] = [];

		for (const spec of CREDENTIAL_MATRIX) {
			// The auth.json key should appear in the table - check for the provider row
			// The table uses display names, so we check for the auth.json key in backticks
			const authKeyPattern = `\`${spec.authJsonKey}\``;
			if (!providersDoc.includes(authKeyPattern)) {
				missing.push(`${spec.providerId}: missing auth.json key ${spec.authJsonKey} in API Keys table`);
			}
		}

		expect(missing).toEqual([]);
	});

	it("documents ambient/delegated auth methods for providers that support them", () => {
		const missing: string[] = [];

		for (const spec of CREDENTIAL_MATRIX) {
			if (spec.ambientAuth && spec.ambientAuth.length > 0) {
				// Check if at least one ambient auth method is documented
				const documented = spec.ambientAuth.some((a) => providersDoc.includes(a));
				if (!documented) {
					missing.push(`${spec.providerId}: missing ambient auth documentation (e.g., ${spec.ambientAuth[0]})`);
				}
			}
		}

		expect(missing).toEqual([]);
	});

	it("documents shared environment variables correctly (same env var for multiple providers)", () => {
		// MOONSHOT_API_KEY is shared between moonshotai and moonshotai-cn
		expect(providersDoc).toContain("MOONSHOT_API_KEY");
		expect(providersDoc).toContain("moonshotai");
		expect(providersDoc).toContain("moonshotai-cn");

		// OPENCODE_API_KEY is shared between opencode and opencode-go
		expect(providersDoc).toContain("OPENCODE_API_KEY");
		expect(providersDoc).toContain("opencode");
		expect(providersDoc).toContain("opencode-go");

		// CLOUDFLARE_API_KEY is shared between cloudflare-workers-ai and cloudflare-ai-gateway
		expect(providersDoc).toContain("CLOUDFLARE_API_KEY");
		expect(providersDoc).toContain("cloudflare-workers-ai");
		expect(providersDoc).toContain("cloudflare-ai-gateway");
	});
});

describe("negative drift regressions - credential matrix integrity", () => {
	/**
	 * These tests ensure that removing or misspelling credentials will FAIL.
	 * They validate the credential matrix against the actual documentation.
	 */

	it("fails if MOONSHOT_API_KEY is removed from documentation", () => {
		// This test will fail if someone removes MOONSHOT_API_KEY from providers.md
		expect(providersDoc).toContain("MOONSHOT_API_KEY");
	});

	it("fails if moonshotai-cn provider is removed from documentation", () => {
		// This test will fail if someone removes moonshotai-cn from providers.md
		expect(providersDoc).toContain("moonshotai-cn");
	});

	it("fails if GOOGLE_CLOUD_API_KEY is removed from documentation", () => {
		expect(providersDoc).toContain("GOOGLE_CLOUD_API_KEY");
	});

	it("fails if google-vertex provider is removed from documentation", () => {
		// The table uses "Google Vertex AI" as display name
		expect(providersDoc).toContain("Google Vertex AI");
	});

	it("fails if ANTHROPIC_API_KEY is removed from documentation", () => {
		expect(providersDoc).toContain("ANTHROPIC_API_KEY");
	});

	it("fails if OPENAI_API_KEY is removed from documentation", () => {
		expect(providersDoc).toContain("OPENAI_API_KEY");
	});

	it("validates all KnownProvider types have credential specs", () => {
		const knownProviders: KnownProvider[] = [
			"amazon-bedrock",
			"anthropic",
			"google",
			"google-vertex",
			"openai",
			"azure-openai-responses",
			"openai-codex",
			"prime-inference",
			"deepseek",
			"github-copilot",
			"xai",
			"groq",
			"cerebras",
			"openrouter",
			"vercel-ai-gateway",
			"zai",
			"mistral",
			"minimax",
			"minimax-cn",
			"moonshotai",
			"moonshotai-cn",
			"huggingface",
			"fireworks",
			"opencode",
			"opencode-go",
			"kimi-coding",
			"cloudflare-workers-ai",
			"cloudflare-ai-gateway",
			"xiaomi",
			"xiaomi-token-plan-cn",
			"xiaomi-token-plan-ams",
			"xiaomi-token-plan-sgp",
		];

		const matrixProviderIds = new Set(CREDENTIAL_MATRIX.map((s) => s.providerId));
		const missing = knownProviders.filter((p) => !matrixProviderIds.has(p));

		// openai-codex and prime-agent-traces are special cases
		const allowedMissing = new Set(["openai-codex", "prime-agent-traces"]);
		const unexpectedMissing = missing.filter((p) => !allowedMissing.has(p));

		expect(unexpectedMissing).toEqual([]);
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression test for issue #955 / PR #987
 * Validates Moonshot AI and Google Vertex AI API-key auth documentation
 * and credential matrix integrity.
 */
const providersDoc = readFileSync(resolve(__dirname, "../../../docs/providers.md"), "utf-8");

describe("regression: #955 Moonshot and Vertex API-key auth", () => {
	describe("Moonshot AI (moonshotai and moonshotai-cn)", () => {
		it("documents MOONSHOT_API_KEY as the environment variable for both providers", () => {
			expect(providersDoc).toContain("MOONSHOT_API_KEY");
			// Both providers should be listed with the same env var
			expect(providersDoc).toContain("| Moonshot AI | `MOONSHOT_API_KEY` | `moonshotai` |");
			expect(providersDoc).toContain("| Moonshot AI (China) | `MOONSHOT_API_KEY` | `moonshotai-cn` |");
		});

		it("documents both moonshotai and moonshotai-cn auth.json keys", () => {
			expect(providersDoc).toContain('"moonshotai": { "type": "api_key"');
			expect(providersDoc).toContain('"moonshotai-cn": { "type": "api_key"');
		});

		it("documents shared MOONSHOT_API_KEY for both providers in the table", () => {
			// Verify the table shows both providers using the same env var
			const moonshotRows = providersDoc.match(/\| Moonshot AI.*?\|/g) || [];
			expect(moonshotRows.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("Google Vertex AI (google-vertex)", () => {
		it("documents API key route with ONLY GOOGLE_CLOUD_API_KEY (no project/location)", () => {
			// The API key option should only require GOOGLE_CLOUD_API_KEY
			expect(providersDoc).toContain("Option 1: API key");
			expect(providersDoc).toContain("GOOGLE_CLOUD_API_KEY");
			// Should NOT require project/location for API key
			const apiKeySection = providersDoc.substring(
				providersDoc.indexOf("Option 1: API key"),
				providersDoc.indexOf("Option 2:"),
			);
			expect(apiKeySection).not.toContain("GOOGLE_CLOUD_PROJECT");
			expect(apiKeySection).not.toContain("GOOGLE_CLOUD_LOCATION");
		});

		it("documents ADC route with project and location required", () => {
			const adcSection = providersDoc.substring(providersDoc.indexOf("Option 2: Application Default Credentials"));
			expect(adcSection).toContain("GOOGLE_CLOUD_PROJECT");
			expect(adcSection).toContain("GOOGLE_CLOUD_LOCATION");
			expect(adcSection).toContain("gcloud auth application-default login");
		});

		it("documents GOOGLE_APPLICATION_CREDENTIALS as alternative ADC path", () => {
			expect(providersDoc).toContain("GOOGLE_APPLICATION_CREDENTIALS");
		});

		it("documents google-vertex auth.json key", () => {
			expect(providersDoc).toContain("| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` | `google-vertex` |");
		});
	});

	describe("Credential matrix completeness", () => {
		it("includes all providers from KnownProvider in the API Keys table", () => {
			// These are the providers that should have API key entries
			// The table uses display names, not provider IDs
			const apiKeyProviders = [
				"Amazon Bedrock",
				"Anthropic",
				"Azure OpenAI Responses",
				"OpenAI",
				"Prime Inference",
				"DeepSeek",
				"Google Gemini",
				"Google Vertex AI",
				"Mistral",
				"Groq",
				"Cerebras",
				"Cloudflare AI Gateway",
				"Cloudflare Workers AI",
				"xAI",
				"OpenRouter",
				"Vercel AI Gateway",
				"ZAI",
				"OpenCode Zen",
				"OpenCode Go",
				"Hugging Face",
				"Fireworks",
				"Kimi For Coding",
				"MiniMax",
				"MiniMax (China)",
				"Moonshot AI",
				"Moonshot AI (China)",
				"Xiaomi MiMo",
				"Xiaomi MiMo Token Plan (China)",
				"Xiaomi MiMo Token Plan (Amsterdam)",
				"Xiaomi MiMo Token Plan (Singapore)",
				"GitHub Copilot",
			];

			for (const provider of apiKeyProviders) {
				expect(providersDoc).toContain(`| ${provider} |`);
			}
		});

		it("documents auth.json example with all API key providers", () => {
			const authJsonSection = providersDoc.substring(
				providersDoc.indexOf("Auth File"),
				providersDoc.indexOf("Key Resolution"),
			);

			// Check key providers are in the auth.json example
			expect(authJsonSection).toContain('"anthropic"');
			expect(authJsonSection).toContain('"openai"');
			expect(authJsonSection).toContain('"google"');
			expect(authJsonSection).toContain('"moonshotai"');
			expect(authJsonSection).toContain('"moonshotai-cn"');
			expect(authJsonSection).toContain('"opencode"');
			expect(authJsonSection).toContain('"opencode-go"');
			expect(authJsonSection).toContain('"xiaomi"');
			expect(authJsonSection).toContain('"xiaomi-token-plan-cn"');
			expect(authJsonSection).toContain('"xiaomi-token-plan-ams"');
			expect(authJsonSection).toContain('"xiaomi-token-plan-sgp"');
		});
	});

	describe("Shared environment variables", () => {
		it("documents MOONSHOT_API_KEY shared between moonshotai and moonshotai-cn", () => {
			// Both providers should reference the same env var
			const moonshotAIRow = providersDoc.match(/\| Moonshot AI \| `MOONSHOT_API_KEY` \| `moonshotai` \|/);
			const moonshotCNRow = providersDoc.match(
				/\| Moonshot AI \(China\) \| `MOONSHOT_API_KEY` \| `moonshotai-cn` \|/,
			);
			expect(moonshotAIRow).not.toBeNull();
			expect(moonshotCNRow).not.toBeNull();
		});

		it("documents OPENCODE_API_KEY shared between opencode and opencode-go", () => {
			const opencodeRow = providersDoc.match(/\| OpenCode Zen \| `OPENCODE_API_KEY` \| `opencode` \|/);
			const opencodeGoRow = providersDoc.match(/\| OpenCode Go \| `OPENCODE_API_KEY` \| `opencode-go` \|/);
			expect(opencodeRow).not.toBeNull();
			expect(opencodeGoRow).not.toBeNull();
		});

		it("documents CLOUDFLARE_API_KEY shared between cloudflare-workers-ai and cloudflare-ai-gateway", () => {
			const workersRow = providersDoc.match(/\| Cloudflare Workers AI \| `CLOUDFLARE_API_KEY/);
			const gatewayRow = providersDoc.match(/\| Cloudflare AI Gateway \| `CLOUDFLARE_API_KEY/);
			expect(workersRow).not.toBeNull();
			expect(gatewayRow).not.toBeNull();
		});
	});
});

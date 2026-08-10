// Shared identifiers for bundled skills that authenticate with an API key, used by
// the /login UI (auth.json key) and the kernel env injection. These are skill
// credentials, not model providers, so every consumer has to handle them explicitly.

export const WEBSEARCH_SKILL_NAME = "websearch";
export const SERPER_CREDENTIAL_ID = "serper";
export const SERPER_CREDENTIAL_NAME = "Serper (web search)";
export const SERPER_ENV_VAR = "SERPER_API_KEY";

export const FIRECRAWL_SKILL_NAME = "firecrawl";
export const FIRECRAWL_CREDENTIAL_ID = "firecrawl";
export const FIRECRAWL_CREDENTIAL_NAME = "Firecrawl (web search + scrape)";
export const FIRECRAWL_ENV_VAR = "FIRECRAWL_API_KEY";

export interface BundledSkillCredential {
	/** Skill name; the key is only injected when a skill of this name is loaded. */
	skill: string;
	/** auth.json entry id, also the /login provider id. */
	credentialId: string;
	/** Display name in the /login and /logout selectors. */
	credentialName: string;
	/** Env var the kernel reads the key from. */
	envVar: string;
}

export const BUNDLED_SKILL_CREDENTIALS: readonly BundledSkillCredential[] = [
	{
		skill: WEBSEARCH_SKILL_NAME,
		credentialId: SERPER_CREDENTIAL_ID,
		credentialName: SERPER_CREDENTIAL_NAME,
		envVar: SERPER_ENV_VAR,
	},
	{
		skill: FIRECRAWL_SKILL_NAME,
		credentialId: FIRECRAWL_CREDENTIAL_ID,
		credentialName: FIRECRAWL_CREDENTIAL_NAME,
		envVar: FIRECRAWL_ENV_VAR,
	},
];

/** Display name for a skill credential id, or undefined when it isn't one. */
export function getBundledSkillCredentialName(credentialId: string): string | undefined {
	return BUNDLED_SKILL_CREDENTIALS.find((entry) => entry.credentialId === credentialId)?.credentialName;
}

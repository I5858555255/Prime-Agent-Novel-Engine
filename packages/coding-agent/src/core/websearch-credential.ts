/**
 * Shared identifiers for the bundled websearch skill's Serper credential.
 *
 * The key is stored in auth.json (via AuthStorage) under SERPER_CREDENTIAL_ID and
 * surfaced in /login. AgentSession resolves it (literal, env-var, or `!command`)
 * and injects SERPER_ENV_VAR into the kernel when the skill is active; the skill
 * also reads auth.json itself so a key added mid-session works.
 */
export const SERPER_CREDENTIAL_ID = "serper";
export const SERPER_CREDENTIAL_NAME = "Serper (web search)";
export const SERPER_ENV_VAR = "SERPER_API_KEY";

/**
 * Shared identifiers for the bundled websearch skill's Serper credential.
 *
 * The key is stored in auth.json (via AuthStorage) under SERPER_CREDENTIAL_ID and
 * surfaced in /login. At kernel build time it is injected into the Python skill's
 * environment as SERPER_ENV_VAR, so the skill keeps reading a plain env var while
 * users never have to set one by hand.
 */
export const SERPER_CREDENTIAL_ID = "serper";
export const SERPER_CREDENTIAL_NAME = "Serper (web search)";
export const SERPER_ENV_VAR = "SERPER_API_KEY";

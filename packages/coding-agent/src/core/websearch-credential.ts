/**
 * Shared identifiers for the bundled websearch skill's Serper credential.
 *
 * The key is stored in auth.json (via AuthStorage) under SERPER_CREDENTIAL_ID and
 * surfaced in /login. The Python skill reads it back itself — from a SERPER_API_KEY
 * env var, then from auth.json — so it works even when the kernel started before the
 * key was added.
 */
export const SERPER_CREDENTIAL_ID = "serper";
export const SERPER_CREDENTIAL_NAME = "Serper (web search)";

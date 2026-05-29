const DISPLAY_ID_LENGTH = 12;
const HEX_ID_PATTERN = /^[0-9a-f]+$/;

export function formatSessionDisplayId(id: string): string {
	const normalized = normalizeSessionId(id);
	if (!normalized) {
		return id.length > DISPLAY_ID_LENGTH ? id.slice(0, DISPLAY_ID_LENGTH) : id;
	}
	return normalized.length > DISPLAY_ID_LENGTH ? normalized.slice(0, DISPLAY_ID_LENGTH) : normalized;
}

export function matchesSessionIdPrefix(candidate: string, prefix: string): boolean {
	const normalizedCandidate = normalizeSessionId(candidate);
	const normalizedPrefix = normalizeSessionId(prefix);
	return !!normalizedCandidate && !!normalizedPrefix && normalizedCandidate.startsWith(normalizedPrefix);
}

function normalizeSessionId(id: string): string | undefined {
	const normalized = id.replaceAll("-", "").toLowerCase();
	return normalized && HEX_ID_PATTERN.test(normalized) ? normalized : undefined;
}

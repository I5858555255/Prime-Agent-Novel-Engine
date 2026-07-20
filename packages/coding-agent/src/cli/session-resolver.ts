import type { SessionInfo } from "../core/session-manager.js";
import { SessionManager } from "../core/session-manager.js";

export type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; path: string }
	| { type: "global"; path: string; cwd: string };

export class SessionSelectorNotFoundError extends Error {
	constructor(
		readonly selector: string,
		readonly suggestion?: string,
	) {
		super(`No session found matching '${selector}'`);
		this.name = "SessionSelectorNotFoundError";
	}
}

export function looksLikeSessionPath(selector: string): boolean {
	return selector.includes("/") || selector.includes("\\") || selector.endsWith(".jsonl");
}

export async function resolveSessionPath(selector: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	if (looksLikeSessionPath(selector)) {
		return { type: "path", path: selector };
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((session) => session.id.startsWith(selector));
	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	const allSessions = await SessionManager.listAll(undefined, sessionDir);
	const globalMatch = allSessions.find((session) => session.id.startsWith(selector));
	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	throw new SessionSelectorNotFoundError(selector, findClosestSessionId(selector, [...localSessions, ...allSessions]));
}

export function findClosestSessionId(
	selector: string,
	sessions: readonly Pick<SessionInfo, "id">[],
): string | undefined {
	const normalizedSelector = normalizeSessionId(selector);
	if (normalizedSelector.length < 4) {
		return undefined;
	}

	const uniqueIds = [...new Set(sessions.map((session) => session.id))];
	let closest: { id: string; distance: number } | undefined;
	let tied = false;

	for (const id of uniqueIds) {
		const normalizedId = normalizeSessionId(id);
		const length = Math.min(normalizedSelector.length, normalizedId.length);
		const distance = Math.min(
			editDistance(normalizedSelector, normalizedId.slice(0, length)),
			editDistance(normalizedSelector, normalizedId.slice(-length)),
		);
		if (!closest || distance < closest.distance) {
			closest = { id, distance };
			tied = false;
		} else if (distance === closest.distance) {
			tied = true;
		}
	}

	const maximumDistance = Math.max(1, Math.floor(normalizedSelector.length / 5));
	return closest && !tied && closest.distance <= maximumDistance ? closest.id : undefined;
}

function normalizeSessionId(id: string): string {
	return id.replaceAll("-", "").toLowerCase();
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = Math.min(
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! + 1,
				diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

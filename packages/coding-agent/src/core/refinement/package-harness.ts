import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ResourceDiagnostic } from "../diagnostics.js";
import type { ResolvedResource } from "../package-manager.js";
import type { HarnessEntry, HarnessState, PackageHarnessProvenance, RefinementKind } from "./refinement.js";

const HARNESS_KINDS = ["prompt", "memory", "skill", "subagent"] as const satisfies readonly RefinementKind[];
const HARNESS_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_HARNESS_IDS = new Set(["prototype"]);
const PACKAGE_HARNESS_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CREDENTIAL_QUERY_KEY =
	/(?:^|[-_])(token|secret|password|passwd|credential|authorization|auth|api[-_]?key|access[-_]?key|signature|sig)(?:$|[-_])/i;
const CREDENTIAL_QUERY_VALUE = /^(?:bearer\s+|basic\s+|gh[pousr]_|github_pat_|glpat-|sk[-_]|xox[baprs]-)/i;

export interface PackageHarnessLoadResult {
	state: HarnessState;
	diagnostics: ResourceDiagnostic[];
}

export function createEmptyPackageHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isHarnessKind(value: string): value is RefinementKind {
	return HARNESS_KINDS.some((kind) => kind === value);
}

function harnessIdError(id: string): string | undefined {
	if (!HARNESS_ID_PATTERN.test(id)) {
		return "package harness id must match [A-Za-z0-9_.-]+";
	}
	if (id in Object.prototype || RESERVED_HARNESS_IDS.has(id)) {
		return `package harness id ${id} is reserved`;
	}
	return undefined;
}

function scopeRank(scope: ResolvedResource["metadata"]["scope"]): number {
	switch (scope) {
		case "project":
			return 0;
		case "user":
			return 1;
		case "temporary":
			return 2;
	}
}

function validatePackageHarnessPath(
	resource: ResolvedResource,
): { kind: RefinementKind; id: string } | { error: string } {
	const baseDir = resource.metadata.baseDir;
	if (!baseDir) {
		return { error: "package harness resource is missing its package root" };
	}

	const relativePath = relative(baseDir, resource.path);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return { error: "package harness file must be inside its package root" };
	}

	const segments = relativePath.split(sep);
	if (segments.length !== 3 || segments[0] !== "harness") {
		return { error: "package harness file must use harness/<kind>/<id>.json" };
	}

	const kind = segments[1];
	if (!kind || !isHarnessKind(kind)) {
		return { error: `package harness path has unsupported kind ${kind || "<empty>"}` };
	}

	const fileName = segments[2];
	if (!fileName?.endsWith(".json")) {
		return { error: "package harness file must use a .json extension" };
	}
	const id = fileName.slice(0, -".json".length);
	if (!id) {
		return { error: "package harness file name must contain a nonempty id" };
	}
	const idError = harnessIdError(id);
	if (idError) {
		return { error: idError };
	}

	return { kind, id };
}

function validatePythonSkillReference(reference: Record<string, unknown>): string | undefined {
	if (reference.type !== "python") {
		return "package harness skill reference.type must be python";
	}
	const hasImport =
		(typeof reference.import === "string" && reference.import.trim().length > 0) ||
		(typeof reference.python_import === "string" && reference.python_import.trim().length > 0);
	if (!hasImport) {
		return "package harness skill requires a python import";
	}
	const hasCallable =
		(typeof reference.callable === "string" && reference.callable.trim().length > 0) ||
		(typeof reference.call_pattern === "string" && reference.call_pattern.trim().length > 0);
	if (!hasCallable) {
		return "package harness skill requires a callable or call_pattern";
	}
	return undefined;
}

function validatePackageHarnessEntry(
	value: unknown,
	expected: { kind: RefinementKind; id: string },
	packageSource: string,
): { entry: HarnessEntry } | { error: string } {
	const record = objectRecord(value);
	if (!record) {
		return { error: "package harness file must contain a JSON object" };
	}

	const stringFields = ["id", "kind", "title", "content"] as const;
	for (const field of stringFields) {
		if (typeof record[field] !== "string" || record[field].trim().length === 0) {
			return { error: `package harness entry ${field} must be a nonempty string` };
		}
	}

	if (record.kind !== expected.kind) {
		return { error: `package harness entry kind must match path kind ${expected.kind}` };
	}
	if (record.id !== expected.id) {
		return { error: `package harness entry id must match file id ${expected.id}` };
	}
	const idError = harnessIdError(record.id as string);
	if (idError) {
		return { error: idError };
	}
	if (record.scope !== undefined && record.scope !== "local" && record.scope !== "global") {
		return { error: "package harness entry scope must be local or global when provided" };
	}

	let entryPath = expected.kind === "prompt" ? "policy" : "general";
	if (record.path !== undefined) {
		if (typeof record.path !== "string" || record.path.trim().length === 0) {
			return { error: "package harness entry path must be a nonempty string when provided" };
		}
		entryPath = record.path;
	}

	const reference = record.reference === undefined ? {} : objectRecord(record.reference);
	if (!reference) {
		return { error: "package harness entry reference must be an object when provided" };
	}
	const argumentsRecord = record.arguments === undefined ? {} : objectRecord(record.arguments);
	if (!argumentsRecord) {
		return { error: "package harness entry arguments must be an object when provided" };
	}
	const metadata = record.metadata === undefined ? {} : objectRecord(record.metadata);
	if (!metadata) {
		return { error: "package harness entry metadata must be an object when provided" };
	}
	const version = record.version === undefined ? 1 : record.version;
	if (!Number.isInteger(version) || (version as number) < 1) {
		return { error: "package harness entry version must be a positive integer when provided" };
	}

	if (expected.kind === "skill") {
		const referenceError = validatePythonSkillReference(reference);
		if (referenceError) {
			return { error: referenceError };
		}
	}

	return {
		entry: {
			id: record.id as string,
			kind: expected.kind,
			title: record.title as string,
			content: record.content as string,
			path: entryPath,
			scope: record.scope === "local" || record.scope === "global" ? record.scope : undefined,
			reference,
			arguments: argumentsRecord,
			metadata,
			source: packageSource,
			created_at: PACKAGE_HARNESS_TIMESTAMP,
			updated_at: PACKAGE_HARNESS_TIMESTAMP,
			version: version as number,
		},
	};
}

function redactCredentialParameters(source: string): string {
	const redacted = source.replace(/([?&#])([^=&]+)=([^&#]*)/g, (match, separator, key, value) => {
		return CREDENTIAL_QUERY_KEY.test(key) || CREDENTIAL_QUERY_VALUE.test(value)
			? `${separator}${key}=[redacted]`
			: match;
	});
	const fragmentIndex = redacted.indexOf("#");
	if (fragmentIndex < 0) {
		return redacted;
	}
	const fragment = redacted.slice(fragmentIndex + 1);
	let decodedFragment = fragment;
	try {
		decodedFragment = decodeURIComponent(fragment);
	} catch {
		// Keep malformed fragments unchanged unless the raw value matches below.
	}
	return CREDENTIAL_QUERY_VALUE.test(decodedFragment) ? `${redacted.slice(0, fragmentIndex)}#[redacted]` : redacted;
}

function redactScpLikeCredentials(source: string): string {
	const queryIndex = source.search(/[?#]/);
	const sourceIdentity = queryIndex < 0 ? source : source.slice(0, queryIndex);
	const suffix = queryIndex < 0 ? "" : source.slice(queryIndex);
	const packagePrefix = sourceIdentity.startsWith("git:") ? "git:" : "";
	const scpIdentity = sourceIdentity.slice(packagePrefix.length);
	const atIndex = scpIdentity.indexOf("@");
	if (atIndex <= 0) {
		return source;
	}

	const userInfo = scpIdentity.slice(0, atIndex);
	const hostPath = scpIdentity.slice(atIndex + 1);
	const looksLikeScpSource = hostPath.includes(":") || hostPath.includes("/");
	const containsCredentials =
		userInfo.includes(":") || CREDENTIAL_QUERY_KEY.test(userInfo) || CREDENTIAL_QUERY_VALUE.test(userInfo);
	if (!looksLikeScpSource || userInfo === "git" || !containsCredentials) {
		return source;
	}

	return `${packagePrefix}${hostPath}${suffix}`;
}

function sanitizePackageSource(source: string): string {
	const urlIndex = source.search(/[A-Za-z][A-Za-z0-9+.-]*:\/\//);
	if (urlIndex < 0) {
		return redactCredentialParameters(redactScpLikeCredentials(source));
	}

	try {
		const prefix = source.slice(0, urlIndex);
		const url = new URL(source.slice(urlIndex));
		url.username = "";
		url.password = "";
		const queryKeysToDelete = new Set<string>();
		for (const [key, value] of url.searchParams) {
			if (CREDENTIAL_QUERY_KEY.test(key) || CREDENTIAL_QUERY_VALUE.test(value)) {
				queryKeysToDelete.add(key);
			}
		}
		for (const key of queryKeysToDelete) {
			url.searchParams.delete(key);
		}
		return redactCredentialParameters(`${prefix}${url.toString()}`);
	} catch {
		return redactCredentialParameters(source.replace(/(\/\/)[^/@\s]+@/, "$1"));
	}
}

function packageProvenance(resource: ResolvedResource): PackageHarnessProvenance {
	return {
		origin: "package",
		source: sanitizePackageSource(resource.metadata.source),
		scope: resource.metadata.scope,
		file: resource.path,
		readOnly: true,
	};
}

export function loadPackageHarness(resources: readonly ResolvedResource[]): PackageHarnessLoadResult {
	const state = createEmptyPackageHarnessState();
	const diagnostics: ResourceDiagnostic[] = [];
	const ordered = resources
		.map((resource, index) => ({ resource, index }))
		.filter(({ resource }) => resource.enabled)
		.sort(
			(left, right) =>
				scopeRank(left.resource.metadata.scope) - scopeRank(right.resource.metadata.scope) ||
				left.index - right.index,
		);

	for (const { resource } of ordered) {
		const pathValidation = validatePackageHarnessPath(resource);
		if ("error" in pathValidation) {
			diagnostics.push({ type: "warning", message: pathValidation.error, path: resource.path });
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(resource.path, "utf8"));
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message:
					error instanceof Error
						? `failed to read package harness entry: ${error.message}`
						: "failed to read package harness entry",
				path: resource.path,
			});
			continue;
		}

		const provenance = packageProvenance(resource);
		const validation = validatePackageHarnessEntry(parsed, pathValidation, provenance.source);
		if ("error" in validation) {
			diagnostics.push({ type: "warning", message: validation.error, path: resource.path });
			continue;
		}

		const entry = { ...validation.entry, provenance };
		const existing = state.entries[entry.kind][entry.id];
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `package harness ${entry.kind}:${entry.id} collision; keeping ${existing.provenance?.source ?? existing.source}`,
				path: resource.path,
				collision: {
					resourceType: "harness",
					name: `${entry.kind}:${entry.id}`,
					winnerPath: existing.provenance?.file ?? existing.path,
					loserPath: resource.path,
					winnerSource: existing.provenance?.source ?? existing.source,
					loserSource: provenance.source,
				},
			});
			continue;
		}
		state.entries[entry.kind][entry.id] = entry;
	}

	return { state, diagnostics };
}

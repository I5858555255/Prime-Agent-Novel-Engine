import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_CONTEXT_ARTIFACT_INLINE_CHARS = 12_000;
export const DEFAULT_CONTEXT_ARTIFACT_PREVIEW_CHARS = 2_400;
export const DEFAULT_CONTEXT_ARTIFACT_RETRIEVAL_MAX_CHARS = 16_000;

const ARTIFACT_SCHEMA = 1;
const ARTIFACT_HANDLE_PREFIX = "ipython-output-";
const CHANNELS = ["stdout", "stderr", "result", "traceback"] as const;
const CHANNEL_HANDLE_PATTERN = /^[a-z]+$/;
const HANDLE_PATTERN = /^ipython-output-[a-f0-9]{64}$/;
const PREVIEW_OMISSION = "\n[… output omitted …]\n";

type ArtifactChannel = (typeof CHANNELS)[number];

export interface ContextArtifactStoreOptions {
	/** Maximum total output chars kept inline before an artifact is created. */
	inlineChars?: number;
	/** Maximum chars included in an inline preview of a spilled channel. */
	previewChars?: number;
	/** Maximum chars returned by one bounded read/search request. */
	retrievalMaxChars?: number;
}

export interface ContextArtifactReference {
	handle: string;
	kind: "ipython-output";
	channels: ArtifactChannel[];
	totalChars: number;
	bytes: number;
	inlinePreview: string;
	/** Host-bridge examples intentionally contain no filesystem path. */
	retrieval: {
		read: string;
		search: string;
	};
}

export interface ContextArtifactReadResult {
	handle: string;
	channel: ArtifactChannel;
	offset: number;
	text: string;
	truncated: boolean;
	totalChars: number;
}

export interface ContextArtifactSearchMatch {
	line: number;
	text: string;
}

export interface ContextArtifactSearchResult {
	handle: string;
	channel: ArtifactChannel;
	query: string;
	matches: ContextArtifactSearchMatch[];
	truncated: boolean;
}

export interface ContextArtifactMaterialization {
	values: Partial<Record<ArtifactChannel, string>>;
	artifact?: ContextArtifactReference;
	oversized: boolean;
}

interface FinalizedCapture {
	channel: ArtifactChannel;
	text?: string;
	tempPath?: string;
	totalChars: number;
	bytes: number;
	digest: string;
	preview: string;
	storageFailed: boolean;
}

function clampPositive(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value) || value === undefined) return fallback;
	return Math.max(1, Math.min(Math.floor(value), maximum));
}

function boundedPreview(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const budget = Math.max(1, maxChars - PREVIEW_OMISSION.length);
	const headChars = Math.ceil(budget / 2);
	const tailChars = Math.max(0, budget - headChars);
	return `${text.slice(0, headChars)}${PREVIEW_OMISSION}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

function boundedPreviewFromEdges(prefix: string, suffix: string, totalChars: number, maxChars: number): string {
	if (totalChars <= maxChars) return prefix.slice(0, totalChars);
	const budget = Math.max(1, maxChars - PREVIEW_OMISSION.length);
	const headChars = Math.ceil(budget / 2);
	const tailChars = Math.max(0, budget - headChars);
	return `${prefix.slice(0, headChars)}${PREVIEW_OMISSION}${tailChars > 0 ? suffix.slice(-tailChars) : ""}`;
}

function safeChannel(channel: unknown): ArtifactChannel {
	if (
		typeof channel !== "string" ||
		!CHANNEL_HANDLE_PATTERN.test(channel) ||
		!CHANNELS.includes(channel as ArtifactChannel)
	) {
		throw new Error("Unknown artifact channel");
	}
	return channel as ArtifactChannel;
}

function safeHandle(handle: unknown): string {
	if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
		throw new Error("Invalid artifact handle");
	}
	return handle;
}

function readMetadata(
	rootDir: string,
	handle: string,
): {
	handle: string;
	channels: Record<ArtifactChannel, { chars: number; bytes: number }>;
	totalChars: number;
} {
	const artifactDir = join(rootDir, handle);
	const metadataPath = join(artifactDir, "metadata.json");
	if (!existsSync(metadataPath)) throw new Error("Artifact not found");
	const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as {
		schema?: unknown;
		handle?: unknown;
		channels?: Partial<Record<ArtifactChannel, { chars?: unknown; bytes?: unknown }>>;
		totalChars?: unknown;
	};
	const totalChars = parsed.totalChars;
	if (
		parsed.schema !== ARTIFACT_SCHEMA ||
		parsed.handle !== handle ||
		!parsed.channels ||
		typeof totalChars !== "number" ||
		!Number.isSafeInteger(totalChars) ||
		totalChars < 0
	) {
		throw new Error("Artifact metadata is invalid");
	}
	const channels = {} as Record<ArtifactChannel, { chars: number; bytes: number }>;
	for (const [rawChannel, rawInfo] of Object.entries(parsed.channels)) {
		const channel = safeChannel(rawChannel);
		const chars = rawInfo?.chars;
		const bytes = rawInfo?.bytes;
		if (
			!rawInfo ||
			typeof chars !== "number" ||
			!Number.isSafeInteger(chars) ||
			chars < 0 ||
			typeof bytes !== "number" ||
			!Number.isSafeInteger(bytes) ||
			bytes < 0
		) {
			throw new Error("Artifact metadata is invalid");
		}
		channels[channel] = { chars, bytes };
	}
	return { handle, channels, totalChars };
}

/**
 * Incrementally captures a stream without retaining unbounded output in memory.
 * Once the inline threshold is crossed, bytes are written to a private temporary
 * file owned by ContextArtifactStore. The capture's preview and digest are always
 * maintained, even if disk persistence fails.
 */
export class ContextArtifactCapture {
	private inlineText = "";
	private tempPath?: string;
	private fd?: number;
	private totalChars = 0;
	private totalBytes = 0;
	private readonly digest = createHash("sha256");
	private prefix = "";
	private suffix = "";
	private storageFailed = false;

	constructor(
		private readonly store: ContextArtifactStore,
		readonly channel: ArtifactChannel,
	) {}

	append(chunk: string): void {
		if (!chunk) return;
		this.totalChars += chunk.length;
		this.totalBytes += Buffer.byteLength(chunk, "utf8");
		this.digest.update(chunk, "utf8");
		this.prefix = `${this.prefix}${chunk}`.slice(0, this.store.previewChars);
		this.suffix = `${this.suffix}${chunk}`.slice(-this.store.previewChars);

		if (this.storageFailed) return;
		try {
			if (this.fd !== undefined) {
				writeSync(this.fd, chunk, null, "utf8");
				return;
			}
			if (this.inlineText.length + chunk.length <= this.store.inlineChars) {
				this.inlineText += chunk;
				return;
			}
			this.startSpill();
			if (this.fd !== undefined) {
				writeSync(this.fd, chunk, null, "utf8");
			}
		} catch {
			this.storageFailed = true;
			this.close();
			if (this.tempPath) rmSync(this.tempPath, { force: true });
			this.tempPath = undefined;
			this.inlineText = "";
		}
	}

	finalize(): FinalizedCapture {
		this.close();
		return {
			channel: this.channel,
			text: this.tempPath || this.storageFailed ? undefined : this.inlineText,
			tempPath: this.tempPath,
			totalChars: this.totalChars,
			bytes: this.totalBytes,
			digest: this.digest.digest("hex"),
			preview:
				this.tempPath || this.storageFailed
					? boundedPreviewFromEdges(this.prefix, this.suffix, this.totalChars, this.store.previewChars)
					: boundedPreview(this.inlineText, this.store.previewChars),
			storageFailed: this.storageFailed,
		};
	}

	private startSpill(): void {
		const tempPath = this.store.createTempPath(this.channel);
		if (!tempPath) {
			this.storageFailed = true;
			this.inlineText = "";
			return;
		}
		this.fd = openSync(tempPath, "w", 0o600);
		this.tempPath = tempPath;
		if (this.inlineText) {
			writeSync(this.fd!, this.inlineText, null, "utf8");
			this.inlineText = "";
		}
	}

	private close(): void {
		if (this.fd !== undefined) {
			closeSync(this.fd);
			this.fd = undefined;
		}
	}
}

/**
 * Durable, path-safe storage for context that is too large for the model's
 * inline tool result. The store intentionally exposes opaque handles only.
 */
export class ContextArtifactStore {
	readonly inlineChars: number;
	readonly previewChars: number;
	private readonly retrievalMaxChars: number;
	private readonly rootDir?: string;
	private readonly artifactRoot?: string;
	private readonly tempRoot?: string;

	constructor(rootDir: string | undefined, options: ContextArtifactStoreOptions = {}) {
		this.inlineChars = clampPositive(options.inlineChars, DEFAULT_CONTEXT_ARTIFACT_INLINE_CHARS, 2_000_000);
		this.previewChars = clampPositive(options.previewChars, DEFAULT_CONTEXT_ARTIFACT_PREVIEW_CHARS, 2_000_000);
		this.retrievalMaxChars = clampPositive(
			options.retrievalMaxChars,
			DEFAULT_CONTEXT_ARTIFACT_RETRIEVAL_MAX_CHARS,
			2_000_000,
		);
		if (rootDir) {
			this.rootDir = resolve(rootDir);
			this.artifactRoot = join(this.rootDir, "ipython-output");
			this.tempRoot = join(this.artifactRoot, ".tmp");
		}
	}

	createCapture(channel: ArtifactChannel): ContextArtifactCapture {
		return new ContextArtifactCapture(this, channel);
	}

	createHostRequestHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		return {
			"artifact.read": async (payload) => this.read(payload),
			"artifact.search": async (payload) => this.search(payload),
		};
	}

	materialize(
		captures: Partial<Record<ArtifactChannel, ContextArtifactCapture>>,
		fallbacks: Partial<Record<ArtifactChannel, string | undefined>> = {},
	): ContextArtifactMaterialization {
		const finalized: FinalizedCapture[] = [];
		for (const channel of CHANNELS) {
			const capture = captures[channel];
			if (capture) {
				const result = capture.finalize();
				if (result.totalChars === 0) {
					if (fallbacks[channel] === undefined) continue;
					const fallbackCapture = this.createCapture(channel);
					fallbackCapture.append(fallbacks[channel]!);
					finalized.push(fallbackCapture.finalize());
				} else {
					finalized.push(result);
				}
			} else if (fallbacks[channel] !== undefined) {
				const fallbackCapture = this.createCapture(channel);
				fallbackCapture.append(fallbacks[channel]!);
				finalized.push(fallbackCapture.finalize());
			}
		}

		const totalChars = finalized.reduce((sum, item) => sum + item.totalChars, 0);
		const oversized = totalChars > this.inlineChars || finalized.some((item) => item.totalChars > this.inlineChars);
		if (!oversized) {
			return {
				values: Object.fromEntries(
					finalized.filter((item) => item.text !== undefined).map((item) => [item.channel, item.text]),
				) as Partial<Record<ArtifactChannel, string>>,
				oversized: false,
			};
		}

		const values: Partial<Record<ArtifactChannel, string>> = {};
		for (const item of finalized) values[item.channel] = item.preview;
		const artifact = this.persist(finalized, totalChars);
		return { values, oversized: true, artifact };
	}

	private persist(captures: readonly FinalizedCapture[], totalChars: number): ContextArtifactReference | undefined {
		if (!this.artifactRoot || captures.some((capture) => capture.storageFailed)) return undefined;
		try {
			this.ensureRoots();
			const handleDigest = createHash("sha256");
			for (const capture of captures) {
				handleDigest.update(`${capture.channel}:${capture.totalChars}:${capture.digest}\n`);
			}
			const handle = `${ARTIFACT_HANDLE_PREFIX}${handleDigest.digest("hex")}`;
			const artifactDir = join(this.artifactRoot, handle);
			if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
			for (const capture of captures) {
				const path = join(artifactDir, `${capture.channel}.txt`);
				if (capture.tempPath) {
					if (!existsSync(path)) renameSync(capture.tempPath, path);
					else rmSync(capture.tempPath, { force: true });
				} else if (!existsSync(path)) {
					const tempPath = join(artifactDir, `.${capture.channel}.${randomUUID()}.tmp`);
					writeFileSync(tempPath, capture.text ?? "", { encoding: "utf8", mode: 0o600, flag: "wx" });
					renameSync(tempPath, path);
				}
			}
			const metadataPath = join(artifactDir, "metadata.json");
			if (!existsSync(metadataPath)) {
				const metadata = {
					schema: ARTIFACT_SCHEMA,
					handle,
					createdAt: new Date().toISOString(),
					totalChars,
					channels: Object.fromEntries(
						captures.map((capture) => [capture.channel, { chars: capture.totalChars, bytes: capture.bytes }]),
					),
				};
				const tempMetadata = join(artifactDir, `.metadata.${randomUUID()}.tmp`);
				writeFileSync(tempMetadata, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				renameSync(tempMetadata, metadataPath);
			}
			const channels = captures.map((capture) => capture.channel);
			const firstChannel = channels[0] ?? "stdout";
			const inlinePreview = captures.map((capture) => `${capture.channel}:\n${capture.preview}`).join("\n\n");
			return {
				handle,
				kind: "ipython-output",
				channels,
				totalChars,
				bytes: captures.reduce((sum, capture) => sum + capture.bytes, 0),
				inlinePreview: boundedPreview(inlinePreview, this.previewChars),
				retrieval: {
					read: `await rlm.host_request("artifact.read", {"handle": "${handle}", "channel": "${firstChannel}"})`,
					search: `await rlm.host_request("artifact.search", {"handle": "${handle}", "channel": "${firstChannel}", "query": "..."})`,
				},
			};
		} catch {
			for (const capture of captures) {
				if (capture.tempPath) rmSync(capture.tempPath, { force: true });
			}
			return undefined;
		}
	}

	private ensureRoots(): void {
		if (!this.artifactRoot || !this.tempRoot) return;
		mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
		mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
	}

	createTempPath(channel: ArtifactChannel): string | undefined {
		if (!this.tempRoot) return undefined;
		try {
			this.ensureRoots();
			const path = join(this.tempRoot, `${channel}-${randomUUID()}.tmp`);
			const fd = openSync(path, "w", 0o600);
			closeSync(fd);
			return path;
		} catch {
			return undefined;
		}
	}

	private async read(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const handle = safeHandle(payload.handle);
		const channel = safeChannel(payload.channel ?? "stdout");
		const metadata = this.requireMetadata(handle);
		const channelMetadata = metadata.channels[channel];
		if (!channelMetadata) throw new Error("Artifact channel not found");
		const requestedOffset =
			typeof payload.offset === "number" && Number.isFinite(payload.offset)
				? Math.max(0, Math.floor(payload.offset))
				: 0;
		const offset = Math.min(requestedOffset, channelMetadata.chars);
		const requested = typeof payload.max_chars === "number" ? payload.max_chars : this.retrievalMaxChars;
		const maxChars = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), this.retrievalMaxChars))
			: this.retrievalMaxChars;
		const filePath = this.channelPath(handle, channel);
		// Offsets are UTF-16 character offsets (the same unit used by totalChars),
		// not byte offsets. Read from the beginning with a bounded UTF-8 stream so
		// multibyte text cannot seek into the middle of a code point.
		let skipped = 0;
		let remaining = maxChars;
		let text = "";
		for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
			if (remaining <= 0) break;
			const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (skipped < offset) {
				const skip = Math.min(offset - skipped, value.length);
				skipped += skip;
				if (skip < value.length) {
					const part = value.slice(skip, skip + remaining);
					text += part;
					remaining -= part.length;
				}
			} else {
				const part = value.slice(0, remaining);
				text += part;
				remaining -= part.length;
			}
		}
		return {
			handle,
			channel,
			offset,
			text,
			truncated: offset + text.length < channelMetadata.chars,
			totalChars: channelMetadata.chars,
		};
	}

	private async search(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const handle = safeHandle(payload.handle);
		const channel = safeChannel(payload.channel ?? "stdout");
		const query = typeof payload.query === "string" ? payload.query.slice(0, 256) : "";
		if (!query) throw new Error("artifact.search requires a non-empty query");
		const requested = typeof payload.max_chars === "number" ? payload.max_chars : this.retrievalMaxChars;
		const maxChars = Math.max(1, Math.min(Math.floor(requested), this.retrievalMaxChars));
		const requestedMatches = typeof payload.max_results === "number" ? payload.max_results : 20;
		const maxResults = Math.max(1, Math.min(Math.floor(requestedMatches), 50));
		this.requireMetadata(handle);
		const filePath = this.channelPath(handle, channel);
		const matches: ContextArtifactSearchMatch[] = [];
		let returnedChars = 0;
		let lineNumber = 0;
		const needle = query.toLocaleLowerCase();
		const input = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
		for await (const line of input) {
			lineNumber += 1;
			if (!line.toLocaleLowerCase().includes(needle)) continue;
			const text = line.slice(0, Math.min(line.length, maxChars - returnedChars));
			matches.push({ line: lineNumber, text });
			returnedChars += text.length;
			if (matches.length >= maxResults || returnedChars >= maxChars) break;
		}
		return { handle, channel, query, matches, truncated: matches.length >= maxResults || returnedChars >= maxChars };
	}

	private requireMetadata(handle: string) {
		if (!this.artifactRoot) throw new Error("No durable artifact store is available for this session");
		return readMetadata(this.artifactRoot, handle);
	}

	private channelPath(handle: string, channel: ArtifactChannel): string {
		if (!this.artifactRoot) throw new Error("No durable artifact store is available for this session");
		const path = resolve(this.artifactRoot, handle, `${channel}.txt`);
		const root = `${resolve(this.artifactRoot)}${"/"}`;
		if (!path.startsWith(root) || !HANDLE_PATTERN.test(handle) || !CHANNELS.includes(channel)) {
			throw new Error("Invalid artifact path");
		}
		if (!existsSync(path)) throw new Error("Artifact channel not found");
		return path;
	}
}

export function boundedArtifactPreview(text: string, maxChars: number): string {
	return boundedPreview(text, maxChars);
}

export function artifactRetrievalGuidance(reference: ContextArtifactReference): string {
	return [
		`Oversized IPython output was materialized as ${reference.handle} (${reference.totalChars.toLocaleString()} chars).`,
		`The inline preview is bounded; retrieve more with ${reference.retrieval.read} or search with ${reference.retrieval.search}.`,
	].join(" ");
}

export type { ArtifactChannel };

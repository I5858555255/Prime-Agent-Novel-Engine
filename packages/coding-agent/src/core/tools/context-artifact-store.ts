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
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_CONTEXT_ARTIFACT_INLINE_CHARS = 12_000;
export const DEFAULT_CONTEXT_ARTIFACT_PREVIEW_CHARS = 2_400;
export const DEFAULT_CONTEXT_ARTIFACT_RETRIEVAL_MAX_CHARS = 16_000;

const ARTIFACT_SCHEMA = 2;
const LEGACY_ARTIFACT_SCHEMA = 1;
const CHECKPOINT_INTERVAL_CHARS = 256_000;
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

interface ArtifactCheckpoint {
	chars: number;
	bytes: number;
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
	checkpoints: readonly ArtifactCheckpoint[];
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Slice UTF-16 text without returning a partial surrogate pair. */
function codePointSafeSlice(text: string, start = 0, end = text.length): string {
	let from = Math.max(0, Math.min(Math.floor(start), text.length));
	let to = Math.max(from, Math.min(Math.floor(end), text.length));
	if (from < to && isLowSurrogate(text.charCodeAt(from))) from += 1;
	for (let index = from; index < to; index += 1) {
		const code = text.charCodeAt(index);
		if (isHighSurrogate(code)) {
			if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) {
				to = index;
				break;
			}
			if (index + 2 > to) {
				to = index;
				break;
			}
			index += 1;
		} else if (isLowSurrogate(code)) {
			to = index;
			break;
		}
	}
	return text.slice(from, Math.max(from, to));
}

function lastCodePointSafeSlice(text: string, maxChars: number): string {
	const limit = Math.max(0, Math.floor(maxChars));
	return codePointSafeSlice(text, Math.max(0, text.length - limit), text.length);
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) count += 1;
	return count;
}

function clampPositive(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value) || value === undefined) return fallback;
	return Math.max(1, Math.min(Math.floor(value), maximum));
}

function boundedPreview(text: string, maxChars: number): string {
	const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : maxChars > 0 ? text.length : 0;
	if (text.length <= limit) return codePointSafeSlice(text);
	if (limit <= PREVIEW_OMISSION.length) return codePointSafeSlice(text, 0, limit);
	const budget = limit - PREVIEW_OMISSION.length;
	const headChars = Math.ceil(budget / 2);
	const tailChars = Math.max(0, budget - headChars);
	return `${codePointSafeSlice(text, 0, headChars)}${PREVIEW_OMISSION}${tailChars > 0 ? lastCodePointSafeSlice(text, tailChars) : ""}`;
}

function boundedPreviewFromEdges(prefix: string, suffix: string, totalChars: number, maxChars: number): string {
	const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : maxChars > 0 ? totalChars : 0;
	if (totalChars <= limit) return codePointSafeSlice(prefix, 0, totalChars);
	if (limit <= PREVIEW_OMISSION.length) return codePointSafeSlice(prefix, 0, limit);
	const budget = limit - PREVIEW_OMISSION.length;
	const headChars = Math.ceil(budget / 2);
	const tailChars = Math.max(0, budget - headChars);
	return `${codePointSafeSlice(prefix, 0, headChars)}${PREVIEW_OMISSION}${tailChars > 0 ? lastCodePointSafeSlice(suffix, tailChars) : ""}`;
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
	channels: Record<ArtifactChannel, { chars: number; bytes: number; checkpoints?: readonly ArtifactCheckpoint[] }>;
	totalChars: number;
} {
	const artifactDir = join(rootDir, handle);
	const metadataPath = join(artifactDir, "metadata.json");
	if (!existsSync(metadataPath)) throw new Error("Artifact not found");
	const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as {
		schema?: unknown;
		handle?: unknown;
		channels?: Partial<
			Record<
				ArtifactChannel,
				{
					chars?: unknown;
					bytes?: unknown;
					checkpoints?: unknown;
				}
			>
		>;
		totalChars?: unknown;
	};
	const totalChars = parsed.totalChars;
	if (
		(parsed.schema !== ARTIFACT_SCHEMA && parsed.schema !== LEGACY_ARTIFACT_SCHEMA) ||
		parsed.handle !== handle ||
		!parsed.channels ||
		typeof totalChars !== "number" ||
		!Number.isSafeInteger(totalChars) ||
		totalChars < 0
	) {
		throw new Error("Artifact metadata is invalid");
	}
	const channels = {} as Record<
		ArtifactChannel,
		{ chars: number; bytes: number; checkpoints?: readonly ArtifactCheckpoint[] }
	>;
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
		let checkpoints: ArtifactCheckpoint[] | undefined;
		if (rawInfo.checkpoints !== undefined) {
			if (!Array.isArray(rawInfo.checkpoints)) throw new Error("Artifact metadata is invalid");
			checkpoints = [];
			let previousChars = -1;
			let previousBytes = -1;
			for (const rawCheckpoint of rawInfo.checkpoints) {
				const checkpoint = rawCheckpoint as { chars?: unknown; bytes?: unknown };
				if (
					!checkpoint ||
					typeof checkpoint.chars !== "number" ||
					!Number.isSafeInteger(checkpoint.chars) ||
					checkpoint.chars < 0 ||
					checkpoint.chars > chars ||
					typeof checkpoint.bytes !== "number" ||
					!Number.isSafeInteger(checkpoint.bytes) ||
					checkpoint.bytes < 0 ||
					checkpoint.bytes > bytes ||
					checkpoint.chars <= previousChars ||
					checkpoint.bytes <= previousBytes
				) {
					throw new Error("Artifact metadata is invalid");
				}
				checkpoints.push({ chars: checkpoint.chars, bytes: checkpoint.bytes });
				previousChars = checkpoint.chars;
				previousBytes = checkpoint.bytes;
			}
		}
		channels[channel] = { chars, bytes, ...(checkpoints ? { checkpoints } : {}) };
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
	private prefixPendingHigh?: string;
	private prefixSaturated = false;
	private pendingHigh?: string;
	private suffix = "";
	private suffixPendingHigh?: string;
	private storageFailed = false;
	private readonly checkpoints: ArtifactCheckpoint[] = [];
	private nextCheckpointChars = CHECKPOINT_INTERVAL_CHARS;
	private persistedChars = 0;
	private persistedBytes = 0;
	private finalized?: FinalizedCapture;
	private consumed = false;
	private disposed = false;

	constructor(
		private readonly store: ContextArtifactStore,
		readonly channel: ArtifactChannel,
	) {}

	append(chunk: string): void {
		if (!chunk || this.disposed || this.finalized) return;
		this.totalChars += chunk.length;
		this.appendPrefixPreview(chunk);
		this.updateSuffixPreview(chunk);

		let value = chunk;
		if (this.pendingHigh) {
			if (isLowSurrogate(value.charCodeAt(0))) {
				this.appendEncodedText(`${this.pendingHigh}${value[0]}`);
				value = value.slice(1);
			} else {
				this.appendEncodedText(this.pendingHigh);
			}
			this.pendingHigh = undefined;
		}
		if (value && isHighSurrogate(value.charCodeAt(value.length - 1))) {
			this.pendingHigh = value[value.length - 1];
			value = value.slice(0, -1);
		}
		this.appendEncodedText(value);
	}

	private appendEncodedText(text: string): void {
		if (!text) return;
		this.totalBytes += Buffer.byteLength(text, "utf8");
		this.digest.update(text, "utf8");
		if (this.storageFailed) return;
		try {
			if (this.fd !== undefined) {
				this.writeSpilledText(text);
				return;
			}
			if (this.inlineText.length + text.length <= this.store.inlineChars) {
				this.inlineText += text;
				return;
			}
			this.startSpill();
			if (this.fd !== undefined) this.writeSpilledText(text);
		} catch {
			this.markStorageFailed();
		}
	}

	private flushPendingHigh(): void {
		if (!this.pendingHigh) return;
		const pendingHigh = this.pendingHigh;
		this.pendingHigh = undefined;
		this.appendEncodedText(pendingHigh);
	}

	finalize(): FinalizedCapture {
		if (this.finalized) return this.finalized;
		this.flushPendingHigh();
		this.recordFinalCheckpoint();
		this.close();
		this.finalized = {
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
			checkpoints: [...this.checkpoints],
		};
		return this.finalized;
	}

	/** Mark a capture as owned by the materialized result; dispose then only closes it. */
	markConsumed(): void {
		this.consumed = true;
	}

	/** Close and remove any private spill file. Safe to call repeatedly. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.flushPendingHigh();
		this.close();
		if (!this.consumed && this.tempPath) rmSync(this.tempPath, { force: true });
		this.tempPath = undefined;
		this.inlineText = "";
	}

	private appendPrefixPreview(chunk: string): void {
		if (this.prefixSaturated) return;
		const maxChars = this.store.previewChars;
		let index = 0;
		if (this.prefixPendingHigh) {
			if (!isLowSurrogate(chunk.charCodeAt(index))) {
				this.prefixPendingHigh = undefined;
				this.prefixSaturated = true;
				return;
			}
			if (this.prefix.length + 2 > maxChars) {
				this.prefixPendingHigh = undefined;
				this.prefixSaturated = true;
				return;
			}
			this.prefix += `${this.prefixPendingHigh}${chunk[index]}`;
			this.prefixPendingHigh = undefined;
			index += 1;
		}
		while (index < chunk.length && this.prefix.length < maxChars) {
			const code = chunk.charCodeAt(index);
			if (isHighSurrogate(code)) {
				if (index + 1 >= chunk.length) {
					this.prefixPendingHigh = chunk[index];
					return;
				}
				if (!isLowSurrogate(chunk.charCodeAt(index + 1)) || this.prefix.length + 2 > maxChars) {
					this.prefixSaturated = true;
					return;
				}
				this.prefix += chunk.slice(index, index + 2);
				index += 2;
				continue;
			}
			if (isLowSurrogate(code)) {
				this.prefixSaturated = true;
				return;
			}
			this.prefix += chunk[index];
			index += 1;
		}
	}

	private updateSuffixPreview(chunk: string): void {
		let index = 0;
		if (this.suffixPendingHigh) {
			if (isLowSurrogate(chunk.charCodeAt(index))) {
				this.appendSuffixSegment(`${this.suffixPendingHigh}${chunk[index]}`);
				index += 1;
			}
			this.suffixPendingHigh = undefined;
		}
		let segmentStart = index;
		while (index < chunk.length) {
			const code = chunk.charCodeAt(index);
			if (isHighSurrogate(code)) {
				if (index + 1 < chunk.length && isLowSurrogate(chunk.charCodeAt(index + 1))) {
					index += 2;
					continue;
				}
				this.appendSuffixSegment(chunk.slice(segmentStart, index));
				if (index + 1 >= chunk.length) this.suffixPendingHigh = chunk[index];
				index += 1;
				segmentStart = index;
				continue;
			}
			if (isLowSurrogate(code)) {
				this.appendSuffixSegment(chunk.slice(segmentStart, index));
				index += 1;
				segmentStart = index;
				continue;
			}
			index += 1;
		}
		this.appendSuffixSegment(chunk.slice(segmentStart));
	}

	private appendSuffixSegment(segment: string): void {
		if (!segment) return;
		const maxChars = this.store.previewChars;
		this.suffix += segment;
		if (this.suffix.length > maxChars + 1) this.suffix = this.suffix.slice(-(maxChars + 1));
		this.suffix = lastCodePointSafeSlice(this.suffix, maxChars);
	}

	private markStorageFailed(): void {
		this.storageFailed = true;
		this.close();
		if (this.tempPath) rmSync(this.tempPath, { force: true });
		this.tempPath = undefined;
		this.inlineText = "";
	}

	private writeSpilledText(text: string): void {
		let offset = 0;
		while (offset < text.length) {
			let end = text.length;
			const charsUntilCheckpoint = this.nextCheckpointChars - this.persistedChars;
			if (charsUntilCheckpoint <= text.length - offset) {
				end = offset + charsUntilCheckpoint;
				if (
					end < text.length &&
					isHighSurrogate(text.charCodeAt(end - 1)) &&
					isLowSurrogate(text.charCodeAt(end))
				) {
					end += 1;
				}
			}
			const segment = text.slice(offset, end);
			writeSync(this.fd!, segment, null, "utf8");
			this.persistedChars += segment.length;
			this.persistedBytes += Buffer.byteLength(segment, "utf8");
			offset = end;
			if (this.persistedChars >= this.nextCheckpointChars) {
				this.checkpoints.push({ chars: this.persistedChars, bytes: this.persistedBytes });
				while (this.nextCheckpointChars <= this.persistedChars) {
					this.nextCheckpointChars += CHECKPOINT_INTERVAL_CHARS;
				}
			}
		}
	}

	private recordFinalCheckpoint(): void {
		if (
			this.fd === undefined ||
			this.pendingHigh ||
			this.totalChars < CHECKPOINT_INTERVAL_CHARS ||
			this.persistedChars !== this.totalChars
		) {
			return;
		}
		if (this.checkpoints.at(-1)?.chars === this.totalChars) return;
		this.checkpoints.push({ chars: this.persistedChars, bytes: this.persistedBytes });
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
		this.checkpoints.push({ chars: 0, bytes: 0 });
		if (this.inlineText) {
			const inlineText = this.inlineText;
			this.inlineText = "";
			this.writeSpilledText(inlineText);
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
		const inputCaptures = Object.values(captures).filter(
			(capture): capture is ContextArtifactCapture => capture !== undefined,
		);
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
			for (const capture of inputCaptures) capture.markConsumed();
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
		if (artifact) {
			for (const capture of inputCaptures) capture.markConsumed();
		}
		return { values, oversized: true, artifact };
	}

	private persist(captures: readonly FinalizedCapture[], totalChars: number): ContextArtifactReference | undefined {
		if (!this.artifactRoot || captures.some((capture) => capture.storageFailed)) {
			this.cleanupTempFiles(captures);
			return undefined;
		}
		let stagingDir: string | undefined;
		try {
			this.ensureRoots();
			const handleDigest = createHash("sha256");
			for (const capture of captures) {
				handleDigest.update(`${capture.channel}:${capture.totalChars}:${capture.digest}\n`);
			}
			const handle = `${ARTIFACT_HANDLE_PREFIX}${handleDigest.digest("hex")}`;
			const artifactDir = join(this.artifactRoot, handle);
			const finalDirectoryExists = existsSync(artifactDir) && statSync(artifactDir).isDirectory();
			if (!finalDirectoryExists) {
				stagingDir = join(this.artifactRoot, `.staging.${randomUUID()}`);
				mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
				for (const capture of captures) {
					const path = join(stagingDir, `${capture.channel}.txt`);
					if (capture.tempPath) {
						renameSync(capture.tempPath, path);
					} else {
						writeFileSync(path, capture.text ?? "", { encoding: "utf8", mode: 0o600, flag: "wx" });
					}
				}
				const metadata = {
					schema: ARTIFACT_SCHEMA,
					handle,
					createdAt: new Date().toISOString(),
					totalChars,
					channels: Object.fromEntries(
						captures.map((capture) => [
							capture.channel,
							{
								chars: capture.totalChars,
								bytes: capture.bytes,
								...(capture.checkpoints.length > 0 ? { checkpoints: capture.checkpoints } : {}),
							},
						]),
					),
				};
				writeFileSync(join(stagingDir, "metadata.json"), `${JSON.stringify(metadata)}\n`, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
				try {
					renameSync(stagingDir, artifactDir);
					stagingDir = undefined;
				} catch (error) {
					if (!(existsSync(artifactDir) && statSync(artifactDir).isDirectory())) throw error;
					if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
					stagingDir = undefined;
				}
			} else {
				this.cleanupTempFiles(captures);
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
			if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
			this.cleanupTempFiles(captures);
			return undefined;
		}
	}

	private cleanupTempFiles(captures: readonly FinalizedCapture[]): void {
		for (const capture of captures) {
			if (capture.tempPath) rmSync(capture.tempPath, { force: true });
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
		const checkpoint = channelMetadata.checkpoints?.filter((candidate) => candidate.chars <= offset).at(-1);
		const stream = checkpoint
			? createReadStream(filePath, { encoding: "utf8", start: checkpoint.bytes })
			: createReadStream(filePath, { encoding: "utf8" });
		// Offsets are UTF-16 character offsets (the same unit used by totalChars),
		// while checkpoints seek by UTF-8 byte offsets. Old schema-1 artifacts have
		// no checkpoints and intentionally use the bounded full scan fallback.
		let skipped = checkpoint ? offset - checkpoint.chars : offset;
		let remaining = maxChars;
		let text = "";
		for await (const chunk of stream) {
			if (remaining <= 0) break;
			const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (skipped > 0) {
				const skip = Math.min(skipped, value.length);
				skipped -= skip;
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
		text = codePointSafeSlice(text, 0, maxChars);
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
		const query = typeof payload.query === "string" ? codePointSafeSlice(payload.query, 0, 256) : "";
		if (!query) throw new Error("artifact.search requires a non-empty query");
		const requested = typeof payload.max_chars === "number" ? payload.max_chars : this.retrievalMaxChars;
		const maxChars = Number.isFinite(requested)
			? Math.max(1, Math.min(Math.floor(requested), this.retrievalMaxChars))
			: this.retrievalMaxChars;
		const queryCodePointLength = Array.from(query).length;
		if (maxChars < query.length) {
			throw new Error(
				`artifact.search max_chars must be at least ${query.length} UTF-16 characters to include the full query (${queryCodePointLength} code points); received ${maxChars}`,
			);
		}
		const requestedMatches = typeof payload.max_results === "number" ? payload.max_results : 20;
		const maxResults = Number.isFinite(requestedMatches)
			? Math.max(1, Math.min(Math.floor(requestedMatches), 50))
			: 20;
		this.requireMetadata(handle);
		const filePath = this.channelPath(handle, channel);
		const matches: ContextArtifactSearchMatch[] = [];
		const needle = query.toLowerCase();
		const contextBudget = Math.max(0, maxChars - query.length);
		const beforeChars = Math.floor(contextBudget / 2);
		const afterChars = contextBudget - beforeChars;
		const carryChars = Math.max(0, query.length - 1);
		const pending: Array<{ line: number; text: string; remainingAfter: number }> = [];
		let returnedChars = 0;
		let lineNumber = 1;
		let carry = "";
		let history = "";
		let truncated = false;
		let stop = false;
		let resultLimitReached = false;

		const flush = (force: boolean) => {
			while (pending.length > 0 && !stop) {
				const candidate = pending[0];
				if (!force && candidate.remainingAfter > 0) break;
				pending.shift();
				let text = candidate.text;
				const remaining = maxChars - returnedChars;
				if (text.length > remaining) text = codePointSafeSlice(text, 0, remaining);
				if (text) {
					matches.push({ line: candidate.line, text });
					returnedChars += text.length;
				}
				if (matches.length >= maxResults || returnedChars >= maxChars) {
					truncated = true;
					stop = true;
				}
			}
		};

		const input = createReadStream(filePath, { encoding: "utf8" });
		for await (const chunk of input) {
			const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const candidate of pending) {
				if (candidate.remainingAfter <= 0) continue;
				const take = Math.min(candidate.remainingAfter, value.length);
				candidate.text += value.slice(0, take);
				candidate.remainingAfter -= take;
			}

			const scan = `${carry}${value}`;
			const scanLower = scan.toLowerCase();
			const scanLineStart = lineNumber - countNewlines(carry);
			for (
				let index = scanLower.indexOf(needle);
				index >= 0 && !resultLimitReached;
				index = scanLower.indexOf(needle, index + 1)
			) {
				if (index + needle.length <= carry.length) continue;
				if (matches.length + pending.length >= maxResults) {
					truncated = true;
					resultLimitReached = true;
					break;
				}
				const relativeStart = index - carry.length;
				const prefix =
					relativeStart >= 0
						? lastCodePointSafeSlice(`${history}${value.slice(0, relativeStart)}`, beforeChars)
						: lastCodePointSafeSlice(
								history.slice(0, Math.max(0, history.length - (carry.length - index))),
								beforeChars,
							);
				const matchText = scan.slice(index, index + query.length);
				const availableAfter = scan.slice(index + query.length, index + query.length + afterChars);
				pending.push({
					line: scanLineStart + countNewlines(scan.slice(0, index)),
					text: `${prefix}${matchText}${availableAfter}`,
					remainingAfter: Math.max(0, afterChars - availableAfter.length),
				});
			}

			history = lastCodePointSafeSlice(`${history}${value}`, beforeChars);
			lineNumber += countNewlines(value);
			carry = lastCodePointSafeSlice(scan, carryChars);
			flush(false);
			if (stop || (resultLimitReached && pending.length === 0)) break;
		}
		flush(true);
		return { handle, channel, query, matches, truncated };
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

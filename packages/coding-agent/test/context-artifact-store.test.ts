import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedArtifactPreview, ContextArtifactStore } from "../src/core/tools/context-artifact-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-context-artifact-"));
	roots.push(root);
	return root;
}

function hasLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= text.length || text.charCodeAt(index + 1) < 0xdc00 || text.charCodeAt(index + 1) > 0xdfff) {
				return true;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

describe("ContextArtifactStore", () => {
	it("keeps small output inline without creating an artifact", () => {
		const store = new ContextArtifactStore(createRoot(), { inlineChars: 100, previewChars: 40 });
		const stdout = store.createCapture("stdout");
		stdout.append("hello from IPython");

		const result = store.materialize({ stdout });

		expect(result.oversized).toBe(false);
		expect(result.artifact).toBeUndefined();
		expect(result.values.stdout).toBe("hello from IPython");
		expect(existsSync(join(roots[0], "ipython-output"))).toBe(false);
	});

	it("spills oversized output, keeps a bounded preview, and emits a stable opaque handle", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 32, previewChars: 100 });
		const fullText = `prefix\n${"middle-secret-value\n".repeat(30)}suffix`;
		const stdout = store.createCapture("stdout");
		stdout.append(fullText);

		const result = store.materialize({ stdout });
		const reference = result.artifact;

		expect(result.oversized).toBe(true);
		expect(reference?.handle).toMatch(/^ipython-output-[a-f0-9]{64}$/);
		expect(result.values.stdout).toContain("prefix");
		expect(result.values.stdout).toContain("suffix");
		expect(result.values.stdout).not.toContain(fullText);
		expect(JSON.stringify(result)).not.toContain(fullText);
		expect(reference?.handle).not.toContain(root);

		const handlers = store.createHostRequestHandlers();
		const read = await handlers["artifact.read"]({
			handle: reference?.handle,
			channel: "stdout",
			max_chars: fullText.length,
		});
		expect(read.text).toBe(fullText);
		expect(read.truncated).toBe(false);

		const repeat = new ContextArtifactStore(root, { inlineChars: 32, previewChars: 100 });
		const repeatCapture = repeat.createCapture("stdout");
		repeatCapture.append(fullText);
		expect(repeat.materialize({ stdout: repeatCapture }).artifact?.handle).toBe(reference?.handle);
		expect(readdirSync(join(root, "ipython-output", ".tmp"))).toHaveLength(0);
	});

	it("preserves the traceback tail while spilling the complete traceback", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 80, previewChars: 100 });
		const tracebackText = `Traceback (most recent call last):\n${"frame with private payload\n".repeat(20)}ValueError: final traceback detail`;
		const traceback = store.createCapture("traceback");
		traceback.append(tracebackText);

		const result = store.materialize({ traceback });

		expect(result.values.traceback).toContain("ValueError: final traceback detail");
		expect(result.values.traceback).toContain("output omitted");
		expect(result.values.traceback).not.toBe(tracebackText);
		const read = await store.createHostRequestHandlers()["artifact.read"]({
			handle: result.artifact?.handle,
			channel: "traceback",
			max_chars: 200,
		});
		expect(read.text).toBe(tracebackText.slice(0, 200));
	});

	it("recovers bounded reads and literal searches from a fresh store instance", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 20, previewChars: 32, retrievalMaxChars: 100 });
		const stdout = store.createCapture("stdout");
		stdout.append("first line\nneedle appears here\nlast line\n");
		const reference = store.materialize({ stdout }).artifact!;

		const resumedStore = new ContextArtifactStore(root, { retrievalMaxChars: 100 });
		const handlers = resumedStore.createHostRequestHandlers();
		const read = await handlers["artifact.read"]({ handle: reference.handle, channel: "stdout", max_chars: 8 });
		const search = await handlers["artifact.search"]({
			handle: reference.handle,
			channel: "stdout",
			query: "needle appears",
			max_chars: 100,
		});

		expect(read.text).toBe("first li");
		expect(read.truncated).toBe(true);
		const searchMatches = search.matches as Array<{ line: number; text: string }>;
		expect(searchMatches).toHaveLength(1);
		expect(searchMatches[0]).toMatchObject({ line: 2 });
		expect(searchMatches[0]?.text).toContain("needle appears here");
	});

	it("reads UTF-8 artifacts using character offsets rather than byte offsets", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 4, previewChars: 16, retrievalMaxChars: 16 });
		const fullText = "α😀prefix\nneedle\n";
		const stdout = store.createCapture("stdout");
		stdout.append(fullText);
		const reference = store.materialize({ stdout }).artifact!;

		const read = await store.createHostRequestHandlers()["artifact.read"]({
			handle: reference.handle,
			channel: "stdout",
			offset: "α😀".length,
			max_chars: 6,
		});

		expect(read.text).toBe(fullText.slice("α😀".length, "α😀".length + 6));
	});

	it("does not expose an absolute path or an oversized secret in returned metadata", () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 24, previewChars: 36 });
		const secret = "UNIQUE_FULL_SECRET_SHOULD_NOT_BE_INLINE";
		const stdout = store.createCapture("stdout");
		stdout.append(`head\n${"safe filler\n".repeat(10)}${secret}\nend`);
		const result = store.materialize({ stdout });
		const encoded = JSON.stringify(result);

		expect(encoded).not.toContain(root);
		expect(encoded).not.toContain(secret);
		expect(readFileSync(join(root, "ipython-output", result.artifact!.handle, "stdout.txt"), "utf8")).toContain(
			secret,
		);
	});

	it("keeps append previews bounded for huge and interleaved chunks", () => {
		const store = new ContextArtifactStore(createRoot(), { inlineChars: 8, previewChars: 48 });
		const fullText = `head${"x".repeat(100_000)}tail`;
		const stdout = store.createCapture("stdout");
		stdout.append(fullText.slice(0, 12));
		stdout.append(fullText.slice(12));

		const result = store.materialize({ stdout });
		expect(result.values.stdout).toBe(boundedArtifactPreview(fullText, 48));
		expect(result.values.stdout!.length).toBeLessThanOrEqual(48);
	});

	it("searches a newline-free 5MB artifact with a bounded centered window", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32, retrievalMaxChars: 128 });
		const fullText = `${"x".repeat(5 * 1024 * 1024)}needle${"y".repeat(200)}`;
		const stdout = store.createCapture("stdout");
		stdout.append(fullText);
		const reference = store.materialize({ stdout }).artifact!;

		const search = await store.createHostRequestHandlers()["artifact.search"]({
			handle: reference.handle,
			channel: "stdout",
			query: "NEEDLE",
			max_chars: 80,
		});
		const text = (search.matches as Array<{ text: string }>)[0]?.text;
		expect(text).toContain("needle");
		expect(text?.length).toBeLessThanOrEqual(80);
		expect(search.truncated).toBe(true);
	});

	it("rejects search windows smaller than the full query", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32 });
		const stdout = store.createCapture("stdout");
		stdout.append("needle appears here");
		const reference = store.materialize({ stdout }).artifact!;
		const search = store.createHostRequestHandlers()["artifact.search"];

		await expect(
			search({ handle: reference.handle, channel: "stdout", query: "needle", max_chars: 1 }),
		).rejects.toThrow("max_chars must be at least 6 UTF-16 characters");
	});

	it("keeps a Unicode query intact at the smallest valid search window", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32 });
		const stdout = store.createCapture("stdout");
		stdout.append("prefix 😀 suffix");
		const reference = store.materialize({ stdout }).artifact!;
		const search = store.createHostRequestHandlers()["artifact.search"];

		await expect(search({ handle: reference.handle, channel: "stdout", query: "😀", max_chars: 1 })).rejects.toThrow(
			"max_chars must be at least 2 UTF-16 characters",
		);
		const result = await search({ handle: reference.handle, channel: "stdout", query: "😀", max_chars: 2 });
		const text = (result.matches as Array<{ text: string }>)[0]?.text;
		expect(text).toBe("😀");
		expect(Array.from(text ?? "")).toHaveLength(1);
		expect(text?.length).toBeLessThanOrEqual(2);
	});

	it("preserves split surrogate pairs before and after spill", async () => {
		const fullText = "a😀b";
		const inlineStore = new ContextArtifactStore(createRoot(), { inlineChars: 8, previewChars: 32 });
		const inlineCapture = inlineStore.createCapture("stdout");
		inlineCapture.append("a\ud83d");
		inlineCapture.append("\ude00b");
		expect(inlineStore.materialize({ stdout: inlineCapture }).values.stdout).toBe(fullText);

		const spillRoot = createRoot();
		const spillStore = new ContextArtifactStore(spillRoot, { inlineChars: 2, previewChars: 32 });
		const spillCapture = spillStore.createCapture("stdout");
		spillCapture.append("a\ud83d");
		spillCapture.append("\ude00b");
		const spilled = spillStore.materialize({ stdout: spillCapture }).artifact!;
		const expectedStore = new ContextArtifactStore(createRoot(), { inlineChars: 2, previewChars: 32 });
		const expectedCapture = expectedStore.createCapture("stdout");
		expectedCapture.append(fullText);
		const expected = expectedStore.materialize({ stdout: expectedCapture }).artifact!;

		expect(spilled.handle).toBe(expected.handle);
		expect(spilled.bytes).toBe(expected.bytes);
		expect(readFileSync(join(spillRoot, "ipython-output", spilled.handle, "stdout.txt"), "utf8")).toBe(fullText);

		const read = spillStore.createHostRequestHandlers()["artifact.read"];
		expect((await read({ handle: spilled.handle, channel: "stdout", offset: 0, max_chars: 16 })).text).toBe(fullText);
		const search = spillStore.createHostRequestHandlers()["artifact.search"];
		const searchResult = await search({ handle: spilled.handle, channel: "stdout", query: "😀", max_chars: 2 });
		expect((searchResult.matches as Array<{ text: string }>)[0]?.text).toBe("😀");
	});

	it("keeps checkpoint byte offsets after a split surrogate at a boundary", () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32 });
		const capture = store.createCapture("stdout");
		const chunkWithHigh = `${"x".repeat(256_000 - 1)}\ud83d`;
		const chunkWithLow = `\ude00y`;
		capture.append(chunkWithHigh);
		capture.append(chunkWithLow);
		const fullText = `${chunkWithHigh}${chunkWithLow}`;
		const reference = store.materialize({ stdout: capture }).artifact!;
		const metadata = JSON.parse(
			readFileSync(join(root, "ipython-output", reference.handle, "metadata.json"), "utf8"),
		) as { channels: { stdout: { checkpoints: Array<{ chars: number; bytes: number }> } } };

		expect(metadata.channels.stdout.checkpoints).toEqual([
			{ chars: 0, bytes: 0 },
			{ chars: 256_001, bytes: Buffer.byteLength(fullText.slice(0, 256_001), "utf8") },
			{ chars: fullText.length, bytes: Buffer.byteLength(fullText, "utf8") },
		]);
	});

	it("emits intermediate checkpoints within one large ASCII append", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32, retrievalMaxChars: 512 });
		const fullText = "0123456789".repeat(70_000);
		const capture = store.createCapture("stdout");
		capture.append(fullText);
		const reference = store.materialize({ stdout: capture }).artifact!;
		const metadataPath = join(root, "ipython-output", reference.handle, "metadata.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			channels: { stdout: { checkpoints?: Array<{ chars: number; bytes: number }> } };
		};
		const checkpoints = metadata.channels.stdout.checkpoints!;
		expect(checkpoints.map((checkpoint) => checkpoint.chars)).toEqual([0, 256_000, 512_000, fullText.length]);
		for (const checkpoint of checkpoints) {
			expect(checkpoint.bytes).toBe(Buffer.byteLength(fullText.slice(0, checkpoint.chars), "utf8"));
		}

		const read = store.createHostRequestHandlers()["artifact.read"];
		const offsets = [0, 255_999, 256_000, 512_000, fullText.length - 37];
		const sparseResults = new Map<number, string>();
		for (const offset of offsets) {
			sparseResults.set(
				offset,
				(await read({ handle: reference.handle, channel: "stdout", offset, max_chars: 37 })).text as string,
			);
		}
		const legacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			schema: number;
			channels: Record<string, { checkpoints?: Array<{ chars: number; bytes: number }> }>;
		};
		legacyMetadata.schema = 1;
		for (const channel of Object.values(legacyMetadata.channels)) delete channel.checkpoints;
		writeFileSync(metadataPath, `${JSON.stringify(legacyMetadata)}\n`);
		for (const offset of offsets) {
			const legacyResult = await read({ handle: reference.handle, channel: "stdout", offset, max_chars: 37 });
			expect(legacyResult.text).toBe(sparseResults.get(offset));
		}
	});

	it("emits code-point-aligned checkpoints within one large multibyte append", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32, retrievalMaxChars: 512 });
		const unit = "α😀β🚀\n";
		const fullText = unit.repeat(150_000);
		const capture = store.createCapture("stdout");
		capture.append(fullText);
		const reference = store.materialize({ stdout: capture }).artifact!;
		const metadataPath = join(root, "ipython-output", reference.handle, "metadata.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			channels: { stdout: { checkpoints?: Array<{ chars: number; bytes: number }> } };
		};
		const checkpoints = metadata.channels.stdout.checkpoints!;
		expect(checkpoints.map((checkpoint) => checkpoint.chars)).toEqual([
			0,
			256_000,
			512_000,
			768_001,
			1_024_001,
			fullText.length,
		]);
		for (const checkpoint of checkpoints) {
			const prefix = fullText.slice(0, checkpoint.chars);
			expect(hasLoneSurrogate(prefix)).toBe(false);
			expect(checkpoint.bytes).toBe(Buffer.byteLength(prefix, "utf8"));
		}

		const read = store.createHostRequestHandlers()["artifact.read"];
		const offsets = [0, 255_999, 256_000, 511_999, 768_000, 768_001, fullText.length - 41];
		const sparseResults = new Map<number, string>();
		for (const offset of offsets) {
			sparseResults.set(
				offset,
				(await read({ handle: reference.handle, channel: "stdout", offset, max_chars: 41 })).text as string,
			);
		}
		const legacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			schema: number;
			channels: Record<string, { checkpoints?: Array<{ chars: number; bytes: number }> }>;
		};
		legacyMetadata.schema = 1;
		for (const channel of Object.values(legacyMetadata.channels)) delete channel.checkpoints;
		writeFileSync(metadataPath, `${JSON.stringify(legacyMetadata)}\n`);
		for (const offset of offsets) {
			const legacyResult = await read({ handle: reference.handle, channel: "stdout", offset, max_chars: 41 });
			expect(legacyResult.text).toBe(sparseResults.get(offset));
		}
	});

	it("flushes an unmatched final high surrogate consistently", async () => {
		const source = "a\ud83d";
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 1, previewChars: 32 });
		const capture = store.createCapture("stdout");
		capture.append("a");
		capture.append("\ud83d");
		const reference = store.materialize({ stdout: capture }).artifact!;
		const expectedStore = new ContextArtifactStore(createRoot(), { inlineChars: 1, previewChars: 32 });
		const expectedCapture = expectedStore.createCapture("stdout");
		expectedCapture.append(source);
		const expected = expectedStore.materialize({ stdout: expectedCapture }).artifact!;

		expect(reference.handle).toBe(expected.handle);
		expect(reference.bytes).toBe(Buffer.byteLength(source, "utf8"));
		expect(readFileSync(join(root, "ipython-output", reference.handle, "stdout.txt"), "utf8")).toBe("a�");

		const read = store.createHostRequestHandlers()["artifact.read"];
		expect((await read({ handle: reference.handle, channel: "stdout", offset: 0, max_chars: 16 })).text).toBe("a�");

		const disposableRoot = createRoot();
		const disposableStore = new ContextArtifactStore(disposableRoot, { inlineChars: 1, previewChars: 32 });
		const disposableCapture = disposableStore.createCapture("stdout");
		disposableCapture.append(source);
		disposableCapture.dispose();
		expect(readdirSync(join(disposableRoot, "ipython-output", ".tmp"))).toHaveLength(0);
	});

	it("finds matches straddling UTF-8 read chunks and centers the returned window", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32 });
		const stdout = store.createCapture("stdout");
		const streamChunkSize = 64 * 1024;
		stdout.append(`${"a".repeat(streamChunkSize - 3)}str`);
		stdout.append(`addled${"b".repeat(80)}`);
		const reference = store.materialize({ stdout }).artifact!;

		const search = await store.createHostRequestHandlers()["artifact.search"]({
			handle: reference.handle,
			channel: "stdout",
			query: "STRADDLED",
			max_chars: 32,
		});
		expect(search.matches).toHaveLength(1);
		expect((search.matches as Array<{ text: string }>)[0]?.text).toContain("straddled");
		expect((search.matches as Array<{ text: string }>)[0]?.text.length).toBeLessThanOrEqual(32);
	});

	it("uses persisted checkpoints for multi-page Unicode reads and falls back for schema 1", async () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32, retrievalMaxChars: 256 });
		const unit = "α😀\n";
		let fullText = "";
		const stdout = store.createCapture("stdout");
		for (let index = 0; index < 12; index += 1) {
			const chunk = unit.repeat(20_000);
			fullText += chunk;
			stdout.append(chunk);
		}
		const reference = store.materialize({ stdout }).artifact!;
		const metadataPath = join(root, "ipython-output", reference.handle, "metadata.json");
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
			schema: number;
			channels: { stdout: { checkpoints?: Array<{ chars: number; bytes: number }> } };
		};
		expect(metadata.schema).toBe(2);
		expect(metadata.channels.stdout.checkpoints!.length).toBeGreaterThanOrEqual(3);

		const read = store.createHostRequestHandlers()["artifact.read"];
		for (const offset of [0, 80_000, 320_000, 640_000, 960_000]) {
			const result = await read({ handle: reference.handle, channel: "stdout", offset, max_chars: 60 });
			expect(result.text).toBe(fullText.slice(offset, offset + 60));
		}

		const legacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		legacyMetadata.schema = 1;
		for (const channel of Object.values(legacyMetadata.channels as Record<string, Record<string, unknown>>)) {
			delete channel.checkpoints;
		}
		writeFileSync(metadataPath, `${JSON.stringify(legacyMetadata)}\n`);
		const legacyRead = await read({ handle: reference.handle, channel: "stdout", offset: 640_000, max_chars: 60 });
		expect(legacyRead.text).toBe(fullText.slice(640_000, 640_060));
	});

	it("does not split emoji at preview or read boundaries", async () => {
		const root = createRoot();
		const source = `${"a".repeat(19)}😀${"b".repeat(20)}`;
		const omissionLength = "\n[… output omitted …]\n".length;
		for (const maxChars of [omissionLength - 1, omissionLength, omissionLength + 1, omissionLength + 10]) {
			expect(boundedArtifactPreview("a".repeat(100), maxChars).length).toBe(maxChars);
		}
		for (const maxChars of [0, 1, 2, 10, 23]) {
			const preview = boundedArtifactPreview(source, maxChars);
			expect(hasLoneSurrogate(preview)).toBe(false);
			expect(preview.length).toBeLessThanOrEqual(maxChars);
		}
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 64 });
		const stdout = store.createCapture("stdout");
		stdout.append(source);
		const reference = store.materialize({ stdout }).artifact!;
		const read = store.createHostRequestHandlers()["artifact.read"];
		const emojiOffset = 19;
		expect(
			(await read({ handle: reference.handle, channel: "stdout", offset: emojiOffset, max_chars: 1 })).text,
		).toBe("");
		expect(
			(await read({ handle: reference.handle, channel: "stdout", offset: emojiOffset, max_chars: 2 })).text,
		).toBe("😀");
		expect(
			(await read({ handle: reference.handle, channel: "stdout", offset: emojiOffset + 1, max_chars: 2 })).text,
		).toBe("b");
	});

	it("does not refill a head preview after a surrogate pair cannot fit", () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 1, previewChars: 5 });
		const capture = store.createCapture("stdout");
		const chunks = ["abcd\ud83d", "\ude00", "fghijkl"];
		for (const chunk of chunks) capture.append(chunk);
		const fullText = chunks.join("");
		const result = store.materialize({ stdout: capture });

		expect(result.values.stdout).toBe(boundedArtifactPreview(fullText, 5));
		expect(result.values.stdout).toBe("abcd");
	});

	it("latches the head after an unmatched high surrogate across chunk splits", () => {
		const root = createRoot();
		const source = "abcd\ud83deFGHI";
		const store = new ContextArtifactStore(root, { inlineChars: 1, previewChars: 5 });
		for (let split = 0; split <= source.length; split += 1) {
			const capture = store.createCapture("stdout");
			capture.append(source.slice(0, split));
			capture.append(source.slice(split));
			const result = store.materialize({ stdout: capture });
			expect(result.values.stdout).toBe("abcd");
		}
	});

	it("keeps previews and persistence chunk-independent for mixed surrogate sequences", () => {
		const root = createRoot();
		const high = String.fromCharCode(0xd83d);
		const low = String.fromCharCode(0xdc00);
		const sequences = [`abcd${high}eFGHI`, `😀x${high}yZ`, `p😀q${high}r`, `a${low}b😀c`, `x😀${high}y${low}z`];
		for (const source of sequences) {
			for (const previewChars of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]) {
				const oneStore = new ContextArtifactStore(root, { inlineChars: 1, previewChars });
				const oneCapture = oneStore.createCapture("stdout");
				oneCapture.append(source);
				const one = oneStore.materialize({ stdout: oneCapture });
				const oneReference = one.artifact!;
				expect(hasLoneSurrogate(one.values.stdout as string)).toBe(false);
				for (let split = 0; split <= source.length; split += 1) {
					const splitStore = new ContextArtifactStore(root, { inlineChars: 1, previewChars });
					const splitCapture = splitStore.createCapture("stdout");
					splitCapture.append(source.slice(0, split));
					splitCapture.append(source.slice(split));
					const splitResult = splitStore.materialize({ stdout: splitCapture });
					expect(splitResult.values.stdout).toBe(one.values.stdout);
					expect(splitResult.artifact?.handle).toBe(oneReference.handle);
					expect(splitResult.artifact?.bytes).toBe(oneReference.bytes);
				}
				const persisted = Buffer.from(source, "utf8").toString("utf8");
				expect(readFileSync(join(root, "ipython-output", oneReference.handle, "stdout.txt"), "utf8")).toBe(
					persisted,
				);
				expect(oneReference.bytes).toBe(Buffer.byteLength(source, "utf8"));
			}
		}
	});

	it("matches bounded previews across capacities and every chunk split", () => {
		const root = createRoot();
		const source = `${"a".repeat(4)}😀${"m".repeat(30)}🚀tail`;
		for (const previewChars of [1, 2, 3, 4, 5, 6, 7, 8, 32]) {
			const store = new ContextArtifactStore(root, { inlineChars: 1, previewChars });
			for (let split = 0; split <= source.length; split += 1) {
				const capture = store.createCapture("stdout");
				capture.append(source.slice(0, split));
				capture.append(source.slice(split));
				const result = store.materialize({ stdout: capture });
				expect(result.values.stdout).toBe(boundedArtifactPreview(source, previewChars));
			}
		}
	});

	it("cleans staging and spill files when atomic publication fails", () => {
		const root = createRoot();
		const store = new ContextArtifactStore(root, { inlineChars: 8, previewChars: 32 });
		const fullText = "x".repeat(100);
		const first = store.createCapture("stdout");
		first.append(fullText);
		const reference = store.materialize({ stdout: first }).artifact!;
		const artifactDir = join(root, "ipython-output", reference.handle);
		rmSync(artifactDir, { recursive: true, force: true });
		writeFileSync(artifactDir, "not a directory");
		const second = store.createCapture("stdout");
		second.append(fullText);
		const result = store.materialize({ stdout: second });

		expect(result.artifact).toBeUndefined();
		expect(readdirSync(join(root, "ipython-output")).filter((entry) => entry.startsWith(".staging.")).length).toBe(0);
		expect(readdirSync(join(root, "ipython-output", ".tmp"))).toHaveLength(0);
	});
});

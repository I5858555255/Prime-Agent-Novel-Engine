import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextArtifactStore } from "../src/core/tools/context-artifact-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-context-artifact-"));
	roots.push(root);
	return root;
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
		expect(search.matches).toEqual([{ line: 2, text: "needle appears here" }]);
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
});

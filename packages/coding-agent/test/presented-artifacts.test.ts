import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { convertToLlm } from "../src/core/messages.js";
import {
	capturePresentedArtifact,
	normalizePresentedArtifactHostPayload,
	PRESENTED_ARTIFACT_CUSTOM_TYPE,
} from "../src/core/presented-artifacts.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("presented artifacts", () => {
	let root: string;
	let sourceDir: string;
	let artifactDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `prime-present-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sourceDir = join(root, "source");
		artifactDir = join(root, "session-artifacts");
		mkdirSync(sourceDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("captures a durable bounded image preview and excludes it from LLM context", async () => {
		const source = join(sourceDir, "sample.png");
		writeFileSync(source, Buffer.from(PNG_BASE64, "base64"));

		const result = await capturePresentedArtifact(
			{ path: source, label: "Generated icon" },
			{ cwd: sourceDir, artifactDir, sessionId: "session-1" },
		);
		unlinkSync(source);

		expect(result.receipt).toMatchObject({
			artifactId: expect.stringMatching(/^[a-f0-9]{16}$/),
			name: "sample.png",
			mimeType: "image/png",
			kind: "image",
		});
		expect(result.message).toMatchObject({
			role: "custom",
			customType: PRESENTED_ARTIFACT_CUSTOM_TYPE,
			display: true,
			details: {
				kind: "image",
				name: "sample.png",
				label: "Generated icon",
				path: expect.stringContaining("presented-artifacts"),
			},
		});
		const content = result.message.content;
		expect(Array.isArray(content) && content[0]).toEqual({ type: "text", text: "Generated icon" });
		expect(Array.isArray(content) && content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(JSON.stringify(result.message)).not.toContain(source);
		expect(convertToLlm([result.message])).toEqual([]);
	});

	it("captures generic files without embedding their bytes in the message", async () => {
		const source = join(sourceDir, "notes.txt");
		writeFileSync(source, "portable handoff");

		const result = await capturePresentedArtifact(
			{ path: "notes.txt" },
			{ cwd: sourceDir, artifactDir, sessionId: "session-1" },
		);
		expect(result.receipt.kind).toBe("file");
		expect(result.message.content).toEqual([
			{ type: "text", text: "Artifact: notes.txt" },
			{ type: "text", text: result.receipt.path },
		]);
		expect(JSON.stringify(result.message)).not.toContain(Buffer.from("portable handoff").toString("base64"));
	});

	it("rejects invalid payloads, missing files, directories, and oversized files", async () => {
		expect(() => normalizePresentedArtifactHostPayload({ path: "", label: 2 })).toThrow("non-empty path");
		expect(() => normalizePresentedArtifactHostPayload({ path: "a", label: "x".repeat(501) })).toThrow("at most 500");
		await expect(
			capturePresentedArtifact(
				{ path: join(sourceDir, "missing.png") },
				{ cwd: sourceDir, artifactDir, sessionId: "session-1" },
			),
		).rejects.toThrow("does not exist");
		await expect(
			capturePresentedArtifact({ path: sourceDir }, { cwd: sourceDir, artifactDir, sessionId: "session-1" }),
		).rejects.toThrow("regular file");

		const large = join(sourceDir, "large.bin");
		writeFileSync(large, Buffer.alloc(20 * 1024 * 1024 + 1));
		await expect(
			capturePresentedArtifact({ path: large }, { cwd: sourceDir, artifactDir, sessionId: "session-1" }),
		).rejects.toThrow("20 MiB");
	});
	it("appends and emits a display-only session message even during an active turn", async () => {
		const source = join(sourceDir, "streamed.png");
		writeFileSync(source, Buffer.from(PNG_BASE64, "base64"));
		const messages: unknown[] = [];
		const appendCustomMessageEntryWithRollback = vi.fn();
		const emit = vi.fn();
		const harness = {
			_ensureRlmSessionDir: () => artifactDir,
			_createEphemeralRlmSessionDir: () => artifactDir,
			agent: { state: { messages } },
			sessionManager: {
				getCwd: () => sourceDir,
				getSessionId: () => "session-live",
				appendCustomMessageEntryWithRollback,
			},
			_emit: emit,
			isStreaming: true,
		};

		const receipt = await AgentSession.prototype.presentArtifact.call(harness as never, {
			path: source,
			label: "Live preview",
		});
		expect(receipt.kind).toBe("image");
		expect(messages).toHaveLength(1);
		expect(appendCustomMessageEntryWithRollback).toHaveBeenCalledTimes(1);
		expect(emit.mock.calls.map(([event]) => event.type)).toEqual(["message_start", "message_end"]);
	});
	it("does not display or retain an artifact when durable persistence fails", async () => {
		const source = join(sourceDir, "persistence-failure.png");
		writeFileSync(source, Buffer.from(PNG_BASE64, "base64"));
		const messages: unknown[] = [];
		const emit = vi.fn();
		const harness = {
			_ensureRlmSessionDir: () => artifactDir,
			_createEphemeralRlmSessionDir: () => artifactDir,
			agent: { state: { messages } },
			sessionManager: {
				getCwd: () => sourceDir,
				getSessionId: () => "session-failing",
				appendCustomMessageEntryWithRollback: () => {
					throw new Error("disk full");
				},
			},
			_emit: emit,
		};

		await expect(AgentSession.prototype.presentArtifact.call(harness as never, { path: source })).rejects.toThrow(
			"disk full",
		);
		expect(messages).toEqual([]);
		expect(emit).not.toHaveBeenCalled();
	});
});

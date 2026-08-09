import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { fileTypeFromBuffer } from "file-type";
import { resizeImage } from "../utils/image-resize.js";
import { IMAGE_MIME_TYPES } from "../utils/mime.js";
import { type CustomMessage, createCustomMessage, PRESENTED_ARTIFACT_CUSTOM_TYPE } from "./messages.js";

export { PRESENTED_ARTIFACT_CUSTOM_TYPE };
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_BASE64_BYTES = 350_000;
const MAX_LABEL_LENGTH = 500;

export interface PresentedArtifactHostPayload {
	path: string;
	label?: string;
}

export interface PresentedArtifactDetails {
	artifactId: string;
	presentationId: string;
	sessionId: string;
	kind: "image" | "file";
	name: string;
	label?: string;
	mimeType: string;
	byteSize: number;
	path: string;
	width?: number;
	height?: number;
	originalWidth?: number;
	originalHeight?: number;
}

export interface PresentedArtifactReceipt {
	artifactId: string;
	presentationId: string;
	kind: "image" | "file";
	name: string;
	mimeType: string;
	byteSize: number;
	path: string;
	width?: number;
	height?: number;
	originalWidth?: number;
	originalHeight?: number;
}

export interface CapturedPresentedArtifact {
	message: CustomMessage<PresentedArtifactDetails>;
	receipt: PresentedArtifactReceipt;
}

export interface CapturePresentedArtifactOptions {
	cwd: string;
	artifactDir: string;
	sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function normalizePresentedArtifactHostPayload(payload: unknown): PresentedArtifactHostPayload {
	if (!isRecord(payload) || typeof payload.path !== "string" || payload.path.trim().length === 0) {
		throw new Error("artifact.present requires a non-empty path");
	}
	if (payload.label !== undefined && typeof payload.label !== "string") {
		throw new Error("artifact.present label must be a string");
	}
	const label = typeof payload.label === "string" ? payload.label.trim() : undefined;
	if (label && label.length > MAX_LABEL_LENGTH) {
		throw new Error(`artifact.present label must be at most ${MAX_LABEL_LENGTH} characters`);
	}
	return { path: payload.path, ...(label ? { label } : {}) };
}

function safeArtifactName(input: string): string {
	const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "artifact";
}

function fallbackMimeType(fileName: string): string {
	switch (extname(fileName).toLowerCase()) {
		case ".txt":
		case ".md":
		case ".csv":
			return "text/plain";
		case ".json":
			return "application/json";
		default:
			return "application/octet-stream";
	}
}

async function captureFile(bytes: Buffer, destinationPath: string): Promise<void> {
	await mkdir(dirname(destinationPath), { recursive: true });
	const temporaryPath = `${destinationPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await writeFile(temporaryPath, bytes, { flag: "wx" });
	try {
		await link(temporaryPath, destinationPath);
	} catch (error) {
		const existing = await readFile(destinationPath).catch(() => undefined);
		if (!existing?.equals(bytes)) throw error;
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

export async function capturePresentedArtifact(
	rawPayload: unknown,
	options: CapturePresentedArtifactOptions,
): Promise<CapturedPresentedArtifact> {
	const payload = normalizePresentedArtifactHostPayload(rawPayload);
	const sourcePath = isAbsolute(payload.path) ? resolve(payload.path) : resolve(options.cwd, payload.path);
	const sourceStat = await stat(sourcePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new Error(`Artifact does not exist: ${payload.path}`);
		throw error;
	});
	if (!sourceStat.isFile()) throw new Error(`Artifact path must be a regular file: ${payload.path}`);
	if (sourceStat.size > MAX_SOURCE_BYTES) {
		throw new Error(`Artifact exceeds the 20 MiB presentation limit: ${payload.path}`);
	}

	const bytes = await readFile(sourcePath);
	if (bytes.byteLength > MAX_SOURCE_BYTES) {
		throw new Error(`Artifact exceeds the 20 MiB presentation limit: ${payload.path}`);
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	const artifactId = digest.slice(0, 16);
	const presentationId = randomUUID();
	const name = basename(sourcePath);
	const destinationDir = join(options.artifactDir, "presented-artifacts");
	const destinationPath = join(destinationDir, `${artifactId}-${safeArtifactName(name)}`);
	const detectedFileType = await fileTypeFromBuffer(bytes);
	const detectedImageMime =
		detectedFileType && IMAGE_MIME_TYPES.has(detectedFileType.mime) ? detectedFileType.mime : null;
	let mimeType = detectedImageMime;
	let kind: "image" | "file" = "file";
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: payload.label ?? `Artifact: ${name}` }];
	let dimensions: Pick<PresentedArtifactDetails, "width" | "height" | "originalWidth" | "originalHeight"> = {};

	if (detectedImageMime) {
		const preview = await resizeImage(
			{ type: "image", data: bytes.toString("base64"), mimeType: detectedImageMime },
			{ maxWidth: 1600, maxHeight: 1600, maxBytes: MAX_PREVIEW_BASE64_BYTES },
		);
		if (!preview) throw new Error(`Artifact is not a readable supported image: ${payload.path}`);
		kind = "image";
		mimeType = preview.mimeType;
		dimensions = {
			width: preview.width,
			height: preview.height,
			originalWidth: preview.originalWidth,
			originalHeight: preview.originalHeight,
		};
		content.push({ type: "image", data: preview.data, mimeType: preview.mimeType });
	} else {
		mimeType = detectedFileType?.mime ?? fallbackMimeType(name);
		content.push({ type: "text", text: destinationPath });
	}
	await captureFile(bytes, destinationPath);

	const details: PresentedArtifactDetails = {
		artifactId,
		presentationId,
		sessionId: options.sessionId,
		kind,
		name,
		...(payload.label ? { label: payload.label } : {}),
		mimeType,
		byteSize: bytes.byteLength,
		path: destinationPath,
		...dimensions,
	};
	return {
		message: createCustomMessage(
			PRESENTED_ARTIFACT_CUSTOM_TYPE,
			content,
			true,
			details,
			new Date().toISOString(),
		) as CustomMessage<PresentedArtifactDetails>,
		receipt: {
			artifactId,
			presentationId,
			kind,
			name,
			mimeType,
			byteSize: bytes.byteLength,
			path: destinationPath,
			...dimensions,
		},
	};
}

export function isPresentedArtifactMessage(message: AgentMessage): message is CustomMessage<PresentedArtifactDetails> {
	return message.role === "custom" && message.customType === PRESENTED_ARTIFACT_CUSTOM_TYPE;
}

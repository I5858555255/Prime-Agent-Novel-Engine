/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return substituteCompatibilityChars(
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n"),
	);
}

function substituteCompatibilityChars(text: string): string {
	return (
		text
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts in the original content */
	index: number;
	/** Length of the matched span in the original content */
	matchLength: number;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

interface TextBoundary {
	lineIndex: number;
	column: number;
}

function getTextBoundary(lines: string[], offset: number): TextBoundary | undefined {
	if (offset < 0) return undefined;

	let lineStart = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const lineEnd = lineStart + lines[lineIndex].length;
		if (offset <= lineEnd) {
			return { lineIndex, column: offset - lineStart };
		}
		lineStart = lineEnd + 1;
	}

	return undefined;
}

function isCodePointBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function mapNormalizedBoundaryToOriginal(
	originalLines: string[],
	normalizedLines: string[],
	originalLineStarts: number[],
	normalizedOffset: number,
): number | undefined {
	const boundary = getTextBoundary(normalizedLines, normalizedOffset);
	if (boundary === undefined) return undefined;

	const originalLine = originalLines[boundary.lineIndex];
	const normalizedLine = normalizedLines[boundary.lineIndex];
	if (!isCodePointBoundary(normalizedLine, boundary.column)) return undefined;

	// Prefix comparisons must not trim: a boundary after interior whitespace
	// (e.g. indentation) would never satisfy equality against the trimmed form.
	const normalizedPrefix = normalizedLine.slice(0, boundary.column);
	const matchesPrefixAt = (column: number): boolean =>
		isCodePointBoundary(originalLine, column) &&
		substituteCompatibilityChars(originalLine.slice(0, column).normalize("NFKC")) === normalizedPrefix;

	// Fast path: when line normalization is 1:1 (no NFKC expansions), columns align.
	if (
		substituteCompatibilityChars(originalLine.normalize("NFKC")).length === originalLine.length &&
		boundary.column <= originalLine.length &&
		matchesPrefixAt(boundary.column)
	) {
		return originalLineStarts[boundary.lineIndex] + boundary.column;
	}

	// Linear candidate pass: accumulate normalized lengths per grapheme cluster and
	// test the exact prefix predicate wherever the running length reaches the target.
	// Composition happens inside a cluster, so decomposed accents accumulate exactly;
	// only exotic cross-cluster normalization effects diverge, and those fall through.
	let runningLength = 0;
	let predicateAttempts = 0;
	for (const { segment, index } of graphemeSegmenter.segment(originalLine)) {
		if (runningLength === normalizedPrefix.length) {
			if (matchesPrefixAt(index)) {
				return originalLineStarts[boundary.lineIndex] + index;
			}
			if (++predicateAttempts >= 4) break;
		}
		if (runningLength > normalizedPrefix.length) break;
		runningLength += substituteCompatibilityChars(segment.normalize("NFKC")).length;
	}
	if (runningLength === normalizedPrefix.length && predicateAttempts < 4 && matchesPrefixAt(originalLine.length)) {
		return originalLineStarts[boundary.lineIndex] + originalLine.length;
	}

	// Exhaustive scan is quadratic, so it is reserved for short lines; longer lines
	// reject the fuzzy match instead of risking a multi-second stall.
	if (originalLine.length <= 2048) {
		for (let scanColumn = 0; scanColumn <= originalLine.length; scanColumn++) {
			if (matchesPrefixAt(scanColumn)) {
				return originalLineStarts[boundary.lineIndex] + scanColumn;
			}
		}
	}
	return undefined;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Returned offsets always refer to the original content, including for fuzzy
 * matches whose normalized spans must be mapped back to original boundaries.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
		};
	}

	const originalLines = content.split("\n");
	const normalizedLines = originalLines.map((line) => normalizeForFuzzyMatch(line));
	if (normalizedLines.join("\n") !== fuzzyContent) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
		};
	}

	const originalLineStarts: number[] = [];
	let originalLineStart = 0;
	for (const line of originalLines) {
		originalLineStarts.push(originalLineStart);
		originalLineStart += line.length + 1;
	}

	const originalStart = mapNormalizedBoundaryToOriginal(
		originalLines,
		normalizedLines,
		originalLineStarts,
		fuzzyIndex,
	);
	const originalEnd = mapNormalizedBoundaryToOriginal(
		originalLines,
		normalizedLines,
		originalLineStarts,
		fuzzyIndex + fuzzyOldText.length,
	);
	if (
		originalStart === undefined ||
		originalEnd === undefined ||
		normalizeForFuzzyMatch(content.slice(originalStart, originalEnd)) !== fuzzyOldText
	) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
		};
	}

	return {
		found: true,
		index: originalStart,
		matchLength: originalEnd - originalStart,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact or fuzzy text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Fuzzy-normalized
 * match spans are mapped back to original offsets, then replacements are
 * applied in reverse order so bytes outside matched spans remain unchanged.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(normalizedContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(normalizedContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (normalizedContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent };
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
	startLine = 1,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	// Offset by startLine so a snippet shows absolute file line numbers.
	const maxLineNum = startLine - 1 + Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = startLine;
	let newLineNum = startLine;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}

import { extractAnsiCode, visibleWidth } from "./utils.js";

const TABLE_MARKER_PREFIX = "\x1b_pi:table:";
const TABLE_START_MARKER = `${TABLE_MARKER_PREFIX}start\x07`;
const TABLE_END_MARKER = `${TABLE_MARKER_PREFIX}end\x07`;

export interface TableCellSelectionRegion {
	line: number;
	col: number;
	width: number;
	table: object;
	row: number;
	column: number;
	segment: number;
}

interface CellMarker {
	kind: "cell-start" | "cell-end";
	row: number;
	column: number;
	segment: number;
}

function cellMarker(kind: CellMarker["kind"], row: number, column: number, segment: number): string {
	return `${TABLE_MARKER_PREFIX}${kind}:${row}:${column}:${segment}\x07`;
}

function parseCellMarker(code: string): CellMarker | null {
	if (!code.startsWith(TABLE_MARKER_PREFIX) || !code.endsWith("\x07")) return null;
	const [kind, rowText, columnText, segmentText] = code.slice(TABLE_MARKER_PREFIX.length, -1).split(":");
	if (kind !== "cell-start" && kind !== "cell-end") return null;
	const row = Number(rowText);
	const column = Number(columnText);
	const segment = Number(segmentText);
	if (![row, column, segment].every(Number.isInteger)) return null;
	return { kind, row, column, segment };
}

export function markTableStart(line: string): string {
	return TABLE_START_MARKER + line;
}

export function markTableEnd(line: string): string {
	return line + TABLE_END_MARKER;
}

export function markTableCell(text: string, row: number, column: number, segment: number): string {
	return cellMarker("cell-start", row, column, segment) + text + cellMarker("cell-end", row, column, segment);
}

export function extractTableCellSelectionRegions(
	lines: string[],
	getTableIdentity: (index: number) => object,
): { lines: string[]; regions: TableCellSelectionRegion[] } {
	if (!lines.some((line) => line.includes(TABLE_MARKER_PREFIX))) {
		return { lines, regions: [] };
	}

	const cleanLines: string[] = [];
	const regions: TableCellSelectionRegion[] = [];
	let table: object | null = null;
	let tableIndex = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const source = lines[lineIndex];
		if (!source.includes(TABLE_MARKER_PREFIX)) {
			cleanLines.push(source);
			continue;
		}
		let clean = "";
		let activeCell: (CellMarker & { col: number }) | null = null;
		let offset = 0;

		while (offset < source.length) {
			const ansi = extractAnsiCode(source, offset);
			if (!ansi) {
				clean += source[offset];
				offset++;
				continue;
			}

			if (ansi.code === TABLE_START_MARKER) {
				table = getTableIdentity(tableIndex++);
			} else if (ansi.code === TABLE_END_MARKER) {
				table = null;
				activeCell = null;
			} else {
				const marker = parseCellMarker(ansi.code);
				if (marker?.kind === "cell-start") {
					activeCell = { ...marker, col: visibleWidth(clean) };
				} else if (marker?.kind === "cell-end" && table && activeCell) {
					const width = visibleWidth(clean) - activeCell.col;
					if (
						width > 0 &&
						marker.row === activeCell.row &&
						marker.column === activeCell.column &&
						marker.segment === activeCell.segment
					) {
						regions.push({
							line: lineIndex,
							col: activeCell.col,
							width,
							table,
							row: marker.row,
							column: marker.column,
							segment: marker.segment,
						});
					}
					activeCell = null;
				} else {
					clean += ansi.code;
				}
			}
			offset += ansi.length;
		}
		cleanLines.push(clean);
	}

	return { lines: cleanLines, regions };
}

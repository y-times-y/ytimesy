import {
	type MemoryRow,
	memoryEntries,
	PERSONAL_SCOPE,
	rowScope,
} from "./memory-overview";
import { memoryTokens } from "./memory-ranking";

/**
 * The memory graph as Blocks: one block of square cells per project (and
 * Personal), each cell one memory line, newest first. A cell's brightness is
 * its recency; replaced or expired lines sit at the end of their block.
 * There are no edges: what a line replaced is read from `replaces`.
 *
 * Cell positions are a pure function of the rows and the date, so the
 * server and the browser draw the same picture; blocks themselves wrap in
 * the page's flow to fit its width. Pure.
 */

/** Added within this many days reads as new. */
export const NEW_DAYS = 7;
/** Cell side and the gap between cells, in CSS pixels. */
export const CELL = 20;
export const CELL_GAP = 6;
/** Columns per block: five, more for large blocks, never wider than a phone. */
const MIN_COLUMNS = 5;
const MAX_COLUMNS = 10;
/** Age in days at which a cell reaches its dimmest tint. */
const FADE_DAYS = 200;

export type BlockCell = {
	readonly id: string;
	readonly row: MemoryRow;
	readonly scope: string;
	/** Top-left corner inside the block's grid, in CSS pixels. */
	readonly x: number;
	readonly y: number;
	/** Days since `added`; null when the line has no date. */
	readonly age: number | null;
	/** Fill strength for an unpinned cell, 0.1 (old) to 0.65 (today). */
	readonly tint: number;
	readonly pinned: boolean;
	/** Replaced by a later statement or expired: kept, no longer used. */
	readonly archived: boolean;
	readonly inferred: boolean;
	readonly fresh: boolean;
	/** The line this one replaced, and the line that replaced this one. */
	readonly replaces?: string;
	readonly replacedBy?: string;
};

export type MemoryBlock = {
	readonly scope: string;
	readonly columns: number;
	readonly width: number;
	readonly height: number;
	readonly cells: readonly BlockCell[];
	/** Lines still in use, and how many of them are new. */
	readonly active: number;
	readonly fresh: number;
	/** Newest `added` date in the block, if any. */
	readonly newest?: string;
};

export const nodeId = (row: Pick<MemoryRow, "path" | "line">) =>
	`${row.path}:${row.line}`;

const DAY = 86_400_000;
function days(from: string, to: string) {
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY,
	);
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / Math.max(1, Math.min(a.size, b.size));
}

/**
 * The line that replaced `older`: among lines from the chat its
 * `superseded-by` names, the one sharing the most words (same file first).
 */
function successor(
	older: MemoryRow,
	rows: readonly MemoryRow[],
	tokens: ReadonlyMap<MemoryRow, ReadonlySet<string>>,
) {
	const by = older.supersededBy?.toLowerCase();
	if (!by) return undefined;
	let best: MemoryRow | undefined;
	let score = 0;
	for (const row of rows) {
		if (row === older || row.chatId?.toLowerCase() !== by) continue;
		const value =
			overlap(tokens.get(older) ?? new Set(), tokens.get(row) ?? new Set()) +
			(row.path === older.path ? 0.01 : 0);
		if (value > score) {
			score = value;
			best = row;
		}
	}
	return best;
}

/** Columns for a block of `count` cells. */
export function blockColumns(count: number) {
	return Math.max(
		MIN_COLUMNS,
		Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count))),
	);
}

/** Fill strength by age: brighter is newer. */
export function recencyTint(age: number | null) {
	if (age === null) return 0.1;
	return 0.1 + 0.55 * Math.max(0, Math.min(1, 1 - age / FADE_DAYS));
}

/** One stable hue per project scope; Personal is neutral. */
const HUES = ["#8fb0f0", "#e0a874", "#a9cf86", "#cf9bc8", "#d6c47a", "#93c5d6"];
export const PERSONAL_HUE = "#b9b9c0";
export function blockHue(scope: string) {
	if (scope === PERSONAL_SCOPE) return PERSONAL_HUE;
	let hash = 0;
	for (const char of scope) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return HUES[hash % HUES.length];
}

/**
 * Rows into blocks: projects by their newest line (then name), Personal
 * last; inside a block, lines in use before archived ones, newest first.
 */
export function memoryBlocks(input: {
	rows: readonly MemoryRow[];
	today: string;
}): MemoryBlock[] {
	const rows = memoryEntries(input.rows);
	const tokens = new Map(
		rows.map((row) => [row, new Set(memoryTokens(row.text))] as const),
	);
	const replacedBy = new Map<MemoryRow, MemoryRow>();
	const replaces = new Map<MemoryRow, MemoryRow>();
	for (const row of rows) {
		const later = successor(row, rows, tokens);
		if (later && !replaces.has(later)) {
			replacedBy.set(row, later);
			replaces.set(later, row);
		}
	}
	const groups = new Map<string, MemoryRow[]>();
	for (const row of rows) {
		const scope = rowScope(row);
		groups.set(scope, [...(groups.get(scope) ?? []), row]);
	}
	const blocks = [...groups.entries()].map(([scope, members]) => {
		const sorted = members
			.map((row) => ({
				row,
				age: row.added ? Math.max(0, days(row.added, input.today)) : null,
			}))
			.sort(
				(a, b) =>
					Number(a.row.replaced) - Number(b.row.replaced) ||
					(a.age ?? Number.POSITIVE_INFINITY) -
						(b.age ?? Number.POSITIVE_INFINITY) ||
					nodeId(a.row).localeCompare(nodeId(b.row)),
			);
		const columns = blockColumns(sorted.length);
		const lines = Math.ceil(sorted.length / columns);
		const cells: BlockCell[] = sorted.map(({ row, age }, index) => {
			const older = replaces.get(row);
			const newer = replacedBy.get(row);
			return {
				id: nodeId(row),
				row,
				scope,
				x: (index % columns) * (CELL + CELL_GAP),
				y: Math.floor(index / columns) * (CELL + CELL_GAP),
				age,
				tint: recencyTint(age),
				pinned: row.rule && !row.replaced,
				archived: row.replaced,
				inferred: row.kind === "inferred",
				fresh: !row.replaced && age !== null && age <= NEW_DAYS,
				...(older ? { replaces: nodeId(older) } : {}),
				...(newer ? { replacedBy: nodeId(newer) } : {}),
			};
		});
		const newest = members
			.map((row) => row.added ?? "")
			.reduce((a, b) => (b > a ? b : a), "");
		return {
			scope,
			columns,
			width: columns * (CELL + CELL_GAP) - CELL_GAP,
			height: Math.max(1, lines) * (CELL + CELL_GAP) - CELL_GAP,
			cells,
			active: cells.filter((cell) => !cell.archived).length,
			fresh: cells.filter((cell) => cell.fresh).length,
			...(newest ? { newest } : {}),
		};
	});
	return blocks.sort(
		(a, b) =>
			Number(a.scope === PERSONAL_SCOPE) - Number(b.scope === PERSONAL_SCOPE) ||
			(b.newest ?? "").localeCompare(a.newest ?? "") ||
			a.scope.localeCompare(b.scope),
	);
}

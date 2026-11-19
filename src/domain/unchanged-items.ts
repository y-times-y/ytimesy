import type { TimelineRow } from "./timeline-activity";

/** Two JSON-shaped values hold the same data (objects by keys, arrays by order). */
export function sameJsonValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let index = 0; index < a.length; index++)
			if (!sameJsonValue(a[index], b[index])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key)) return false;
		if (
			!sameJsonValue(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		)
			return false;
	}
	return true;
}

/**
 * `next` with every item that holds the same data as the previous item of
 * its id replaced by that previous object; `previous` itself when nothing
 * changed. Each progress snapshot arrives as new objects, and memoized rows
 * only skip work for the objects they already drew.
 */
export function reuseUnchangedItems<Item extends { readonly id: string }>(
	previous: readonly Item[],
	next: readonly Item[],
): readonly Item[] {
	if (previous === next) return previous;
	const byId = new Map(previous.map((item) => [item.id, item]));
	let changed = previous.length !== next.length;
	const reused = next.map((item, index) => {
		const old = byId.get(item.id);
		const kept = old && sameJsonValue(old, item) ? old : item;
		if (kept !== previous[index]) changed = true;
		return kept;
	});
	return changed ? reused : previous;
}

/**
 * `next` rows, each replaced by the previous row of its kind and id when it
 * shows the same item objects (after reuseUnchangedItems) and labels.
 */
export function reuseUnchangedRows(
	previous: readonly TimelineRow[],
	next: readonly TimelineRow[],
): TimelineRow[] {
	const byKey = new Map(previous.map((row) => [timelineRowKey(row), row]));
	return next.map((row) => {
		const old = byKey.get(timelineRowKey(row));
		return old && sameTimelineRow(old, row) ? old : row;
	});
}

function timelineRowKey(row: TimelineRow) {
	return row.kind === "item" ? `item:${row.item.id}` : `${row.kind}:${row.id}`;
}

function sameTimelineRow(a: TimelineRow, b: TimelineRow): boolean {
	if (a.kind === "item") return b.kind === "item" && a.item === b.item;
	if (b.kind === "item" || a.id !== b.id || !sameItemList(a.items, b.items))
		return false;
	if (a.kind === "work") return b.kind === "work" && a.label === b.label;
	if (a.kind === "commands") return b.kind === "commands";
	return b.kind === "exploration" && sameJsonValue(a.counts, b.counts);
}

function sameItemList(a: readonly unknown[], b: readonly unknown[]) {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

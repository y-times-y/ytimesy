import { activityGlyphForToolName } from "./session-activity";
import type { SessionItem } from "./session-item";

export type ExplorationCounts = {
	readonly files: number;
	readonly searches: number;
};

export type TimelineRow =
	| { readonly kind: "item"; readonly item: SessionItem }
	| {
			readonly kind: "exploration";
			readonly id: SessionItem["id"];
			readonly counts: ExplorationCounts;
			readonly items: readonly SessionItem[];
	  };

export function isExplorationItem(item: SessionItem): boolean {
	if (item.kind === "fileChange") return true;
	if (item.kind === "webSearch") return true;
	if (item.kind === "dynamicToolCall") {
		return isExplorationGlyph(activityGlyphForToolName(item.tool));
	}
	if (item.kind === "unknown") {
		return isExplorationGlyph(activityGlyphForToolName(item.type));
	}
	return false;
}

export function explorationCounts(
	items: readonly SessionItem[],
): ExplorationCounts {
	let files = 0;
	let searches = 0;
	for (const item of items) {
		if (item.kind === "fileChange") {
			files += item.changes.length;
			continue;
		}
		if (item.kind === "webSearch") {
			searches += 1;
			continue;
		}
		const name =
			item.kind === "dynamicToolCall"
				? item.tool
				: item.kind === "unknown"
					? item.type
					: "";
		if (isExplorationGlyph(activityGlyphForToolName(name))) {
			if (activityGlyphForToolName(name) === "read") files += 1;
			else searches += 1;
		}
	}
	return { files, searches };
}

export function explorationLabel(counts: ExplorationCounts): string {
	const parts: string[] = [];
	if (counts.files > 0) {
		parts.push(counts.files === 1 ? "1 file" : `${counts.files} files`);
	}
	if (counts.searches > 0) {
		parts.push(
			counts.searches === 1 ? "1 search" : `${counts.searches} searches`,
		);
	}
	if (parts.length === 0) return "Explored";
	return `Explored ${parts.join(" ")}`;
}

export function groupTimelineRows(
	items: readonly SessionItem[],
): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let index = 0;
	while (index < items.length) {
		const item = items[index];
		if (!item) break;
		if (!isExplorationItem(item)) {
			rows.push({ kind: "item", item });
			index += 1;
			continue;
		}
		const grouped: SessionItem[] = [];
		while (index < items.length) {
			const next = items[index];
			if (!next || !isExplorationItem(next)) break;
			grouped.push(next);
			index += 1;
		}
		const first = grouped[0];
		if (!first) continue;
		rows.push({
			kind: "exploration",
			id: first.id,
			counts: explorationCounts(grouped),
			items: grouped,
		});
	}
	return rows;
}

function isExplorationGlyph(glyph: string): boolean {
	return glyph === "search" || glyph === "read" || glyph === "web";
}

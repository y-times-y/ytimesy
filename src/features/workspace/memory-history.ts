import { MANUAL_SOURCE } from "#/domain/memory-edit";
import { chatIdFromSource, parseMemoryLine } from "#/domain/memory-repo";

export type MemoryHistoryChange = {
	readonly change: "add" | "delete" | "update";
	/** The memory text without its `[key: value]` tags. */
	readonly text: string;
	readonly manual: boolean;
	readonly chatId: string | null;
	/** `YYYY-MM-DD` from the `added:` tag, when present. */
	readonly added?: string;
};

/**
 * A commit's unified patch as memory entries: added and removed bullets with
 * their tags parsed out. A line removed and re-added with the same text (only
 * its tags changed) reads as one update. Headings and context lines are dropped.
 */
export function memoryHistoryChanges(patch: string): MemoryHistoryChange[] {
	const changes: MemoryHistoryChange[] = [];
	for (const line of patch.split("\n")) {
		const sign = line[0];
		if ((sign !== "+" && sign !== "-") || /^(\+\+\+|---)\s/.test(line))
			continue;
		const entry = parseMemoryLine(line.slice(1));
		if (!entry) continue;
		const source = entry.meta.source?.trim() ?? "";
		changes.push({
			change: sign === "+" ? "add" : "delete",
			text: entry.text,
			manual: source === MANUAL_SOURCE,
			chatId: source ? chatIdFromSource(source) : null,
			...(entry.meta.added ? { added: entry.meta.added } : {}),
		});
	}
	const merged: MemoryHistoryChange[] = [];
	for (const change of changes) {
		const twin =
			change.change === "add"
				? merged.findIndex(
						(other) => other.change === "delete" && other.text === change.text,
					)
				: -1;
		if (twin >= 0) merged[twin] = { ...change, change: "update" };
		else merged.push(change);
	}
	return merged;
}

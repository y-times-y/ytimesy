import { isUnifiedDiff } from "./diff-stats";
import type { FileChangeEntry } from "./session-item";

export type DiffPreviewLine = {
	readonly kind: "add" | "del" | "ctx";
	readonly text: string;
	readonly number: number;
};

const PREVIEW_LINE_LIMIT = 400;

export function diffPreviewLines(
	change: FileChangeEntry,
): readonly DiffPreviewLine[] {
	const preview = change.preview;
	if (!preview) return [];
	if (isUnifiedDiff(preview)) return unifiedPreviewLines(preview);
	const kind = change.change === "delete" ? "del" : "add";
	return preview
		.split("\n")
		.slice(0, PREVIEW_LINE_LIMIT)
		.map((text, index) => ({ kind, text, number: index + 1 }));
}

function unifiedPreviewLines(diff: string): DiffPreviewLine[] {
	const lines: DiffPreviewLine[] = [];
	const raw = diff.split("\n");
	for (const [index, line] of raw.entries()) {
		if (lines.length >= PREVIEW_LINE_LIMIT) break;
		if (index === raw.length - 1 && line === "") continue;
		if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("+++") ||
			line.startsWith("---") ||
			line.startsWith("@@")
		) {
			continue;
		}
		if (line.startsWith("+")) {
			lines.push({
				kind: "add",
				text: line.slice(1),
				number: lines.length + 1,
			});
			continue;
		}
		if (line.startsWith("-")) {
			lines.push({
				kind: "del",
				text: line.slice(1),
				number: lines.length + 1,
			});
			continue;
		}
		lines.push({
			kind: "ctx",
			text: line.startsWith(" ") ? line.slice(1) : line,
			number: lines.length + 1,
		});
	}
	return lines;
}

export function fileChangeTotals(changes: readonly FileChangeEntry[]): {
	readonly additions: number;
	readonly deletions: number;
} {
	return changes.reduce(
		(totals, change) => ({
			additions: totals.additions + change.additions,
			deletions: totals.deletions + change.deletions,
		}),
		{ additions: 0, deletions: 0 },
	);
}

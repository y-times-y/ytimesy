import { fileChangeTotals } from "./diff-preview";
import { fileBasename } from "./file-kind";
import type { FileChangeEntry } from "./session-item";

export function fileChangeActivityTitle(
	changes: readonly FileChangeEntry[],
): string {
	if (changes.length === 0) return "Edited files";
	if (changes.length === 1) {
		const change = changes[0];
		if (!change) return "Edited files";
		const verb =
			change.change === "add"
				? "Created"
				: change.change === "delete"
					? "Deleted"
					: "Edited";
		return `${verb} ${fileBasename(change.path)}`;
	}
	return `Edited ${changes.length} files`;
}

export function filesChangedLabel(count: number): string {
	return count === 1 ? "1 file changed" : `${count} files changed`;
}

export function fileChangesHeading(changes: readonly FileChangeEntry[]): {
	readonly label: string;
	readonly additions: number;
	readonly deletions: number;
} {
	const totals = fileChangeTotals(changes);
	return {
		label: filesChangedLabel(changes.length),
		additions: totals.additions,
		deletions: totals.deletions,
	};
}

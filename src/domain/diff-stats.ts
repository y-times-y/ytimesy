export type DiffLineCounts = {
	readonly additions: number;
	readonly deletions: number;
};

export function emptyDiffLineCounts(): DiffLineCounts {
	return { additions: 0, deletions: 0 };
}

export function countDiffLineChanges(
	diff: string | null | undefined,
): DiffLineCounts {
	if (!diff) return emptyDiffLineCounts();
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (
			line.startsWith("+++") ||
			line.startsWith("---") ||
			line.startsWith("\\")
		) {
			continue;
		}
		if (line.startsWith("+")) additions += 1;
		else if (line.startsWith("-")) deletions += 1;
	}
	return { additions, deletions };
}

export function readDiffLineCounts(
	additions: unknown,
	deletions: unknown,
	diff: string | null | undefined,
): DiffLineCounts {
	if (typeof additions === "number" && typeof deletions === "number") {
		return {
			additions: Math.max(0, additions),
			deletions: Math.max(0, deletions),
		};
	}
	return countDiffLineChanges(diff);
}

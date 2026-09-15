import { countFileChangeLines } from "./diff-stats";
import type { FileChangeEntry } from "./session-item";

export function fileChangesFromGitPorcelain(
	porcelain: string,
	previews: Readonly<Record<string, string>> = {},
): FileChangeEntry[] {
	const changes: FileChangeEntry[] = [];
	for (const line of porcelain.split("\n")) {
		const parsed = parsePorcelainLine(line);
		if (!parsed) continue;
		const preview = previews[parsed.path] ?? null;
		const counts = countFileChangeLines(parsed.change, preview);
		changes.push({
			path: parsed.path,
			change: parsed.change,
			additions: counts.additions,
			deletions: counts.deletions,
			preview,
		});
	}
	return changes;
}

function parsePorcelainLine(line: string) {
	if (line.length < 4) return null;
	const code = line.slice(0, 2);
	const path = line.slice(3).replace(/^"|"$/g, "").split(" -> ").at(-1);
	if (!path) return null;
	if (code === "??" || code.includes("A")) {
		return { path, change: "add" as const };
	}
	if (code.includes("D")) {
		return { path, change: "delete" as const };
	}
	if (code.includes("M") || code.includes("U") || code.includes("R")) {
		return { path, change: "update" as const };
	}
	return null;
}

import { countDiffLineChanges } from "./diff-stats";
import type { FileChangeEntry } from "./session-item";

/** Each file's patch is capped so one huge generated file cannot flood the view. */
const PATCH_LIMIT = 200_000;

/**
 * Splits `git diff` output (including `--no-index` diffs of new files) into one
 * entry per file, with the file's own unified patch as its preview.
 */
export function parseGitDiffChanges(
	output: string,
	pathPrefix = "",
): FileChangeEntry[] {
	const changes = new Map<string, FileChangeEntry>();
	const sections = output.split(/^(?=diff --git )/m);
	for (const section of sections) {
		if (!section.startsWith("diff --git ")) continue;
		const header = section.slice(0, section.indexOf("\n") + 1 || undefined);
		const newPath =
			/^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ??
			/^rename to (.+)$/m.exec(section)?.[1];
		const oldPath = /^--- a\/(.+)$/m.exec(section)?.[1];
		const fallback = /^diff --git a\/(.+?) b\/(.+)$/m.exec(header);
		const path = (newPath ?? oldPath ?? fallback?.[2] ?? "").trim();
		if (!path || path === "/dev/null") continue;
		const deleted =
			/^deleted file mode/m.test(section) || newPath === undefined;
		const added =
			/^new file mode/m.test(section) || /^--- \/dev\/null$/m.test(section);
		const binary = /^Binary files .* differ$/m.test(section);
		const counts = countDiffLineChanges(section);
		changes.set(`${pathPrefix}${path}`, {
			path: `${pathPrefix}${path}`,
			change: added ? "add" : deleted && oldPath ? "delete" : "update",
			additions: counts.additions,
			deletions: counts.deletions,
			preview: binary ? null : section.slice(0, PATCH_LIMIT),
		});
	}
	return [...changes.values()];
}

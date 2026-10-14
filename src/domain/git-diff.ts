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

/** Printed after a workspace diff that exceeded the byte cap. */
export const WORKSPACE_DIFF_TRUNCATED_MARKER = "__YTIMESY_DIFF_TRUNCATED__";
export const WORKSPACE_DIFF_BYTE_LIMIT = 4_000_000;
export const WORKSPACE_DIFF_TRUNCATED_NOTE = `[Diff truncated: the workspace diff exceeds ${WORKSPACE_DIFF_BYTE_LIMIT / 1_000_000} MB, so this file and any later files are incomplete.]`;

/**
 * Parses the Changes script output. A capped diff still lists every file it
 * reached; the last one is cut short, so its preview carries a visible note.
 */
export function parseWorkspaceDiffOutput(output: string, pathPrefix = "") {
	const markerAt = output.lastIndexOf(`\n${WORKSPACE_DIFF_TRUNCATED_MARKER}`);
	const truncated = markerAt >= 0;
	const changes = parseGitDiffChanges(
		truncated ? output.slice(0, markerAt) : output,
		pathPrefix,
	);
	const last = changes.at(-1);
	if (truncated && last)
		changes[changes.length - 1] = {
			...last,
			preview: `${last.preview ?? ""}\n${WORKSPACE_DIFF_TRUNCATED_NOTE}\n`,
		};
	return { changes, truncated };
}

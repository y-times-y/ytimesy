import { posixShellQuoted } from "#/domain/posix-command";
import type { PublicationAuthor } from "#/domain/publication";
import { setupManagedGitForQuotedDirectory } from "../managed-git-identity";

export const PROJECT_CWD_PATH = "/tmp/ytimesy-project-cwd";

/**
 * Finds the prepared checkout and, in the same round trip, its current
 * branch and the path note's contents, so reusing a checkout costs one
 * guest command instead of three.
 */
export function reusePreparedCheckoutCommand(
	repoName: string,
	author?: PublicationAuthor | null,
) {
	return `HOME="\${HOME:-/home/ubuntu}"
DEST="$HOME/"${posixShellQuoted(repoName)}
if [ -e "$DEST/.git" ]; then
  ${setupManagedGitForQuotedDirectory('"$DEST"', author)} || exit 1
  echo present
  echo "$DEST"
  printf 'branch:%s\\n' "$(git -C "$DEST" branch --show-current 2>/dev/null)"
  printf 'cwd:%s\\n' "$(cat ${posixShellQuoted(PROJECT_CWD_PATH)} 2>/dev/null)"
fi`;
}

export function preparedCheckoutPathFromReuse(stdout: string): string | null {
	return preparedCheckoutFromReuse(stdout)?.path ?? null;
}

/**
 * The reused checkout's path, with its branch and the path note as the
 * command saw them (undefined when its output did not say).
 */
export function preparedCheckoutFromReuse(stdout: string): {
	path: string;
	branch?: string;
	cwdNote?: string;
} | null {
	const lines = stdout.split(/\r?\n/);
	const index = lines.findIndex((line) => line.trim() === "present");
	if (index < 0) return null;
	const path = lines[index + 1]?.trim() ?? "";
	if (!path.startsWith("/")) return null;
	const field = (name: string) => {
		const line = lines
			.slice(index + 2)
			.find((candidate) => candidate.startsWith(`${name}:`));
		return line === undefined ? undefined : line.slice(name.length + 1).trim();
	};
	return { path, branch: field("branch"), cwdNote: field("cwd") };
}

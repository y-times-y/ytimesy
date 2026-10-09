import { posixShellQuoted as quote } from "./posix-command";

/** Preserve local branch histories; never carry dirty edits into a different branch. */
export function switchBrokeredBranchCommand(directory: string, branch: string) {
	const dest = quote(directory);
	const target = quote(branch);
	return `test -z "$(git -C ${dest} status --porcelain)" || { echo 'Commit or stash uncommitted changes before switching branches.' >&2; exit 1; }
if git -C ${dest} show-ref --verify --quiet ${quote(`refs/heads/${branch}`)}; then
  git -C ${dest} -c core.hooksPath=/dev/null checkout ${target}
else
  git -C ${dest} -c core.hooksPath=/dev/null checkout -b ${target} FETCH_HEAD
fi`;
}

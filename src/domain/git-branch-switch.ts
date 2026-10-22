import { posixShellQuoted as quote } from "./posix-command";

/** Preserve local branch histories; never carry dirty edits into a different branch. */
export function switchBrokeredBranchCommand(
	directory: string,
	branch: string,
	/** Where a new local branch starts (a pinned revision); the fetched head by default. */
	start = "FETCH_HEAD",
) {
	const dest = quote(directory);
	const target = quote(branch);
	return `test -z "$(git -C ${dest} status --porcelain)" || { echo 'Commit or stash uncommitted changes before switching branches.' >&2; exit 1; }
if git -C ${dest} show-ref --verify --quiet ${quote(`refs/heads/${branch}`)}; then
  git -C ${dest} -c core.hooksPath=/dev/null checkout ${target}
else
  git -C ${dest} -c core.hooksPath=/dev/null checkout -b ${target} ${start}
fi`;
}

/**
 * Runs after a fetch by URL left the remote branch in FETCH_HEAD: checks out
 * the chat's branch and records where the remote branch and the chat's base
 * now stand.
 */
export function fetchedBranchCommand(input: {
	directory: string;
	/** The remote branch that was fetched. */
	branch: string;
	/** The branch the chat works on. */
	workingBranch: string;
	mode: "clone" | "update" | "switch";
	originUrl: string;
	/**
	 * A commit on the fetched branch the checkout and its base must land on
	 * (resolved before the VM was ready, see api-turn-workspace.ts), instead
	 * of wherever the branch moved since. Missing from the fetch, it fails.
	 */
	pinnedRevision?: string;
}) {
	if (input.pinnedRevision && !/^[a-f0-9]{40,64}$/.test(input.pinnedRevision))
		throw new Error("Invalid pinned revision.");
	const dest = quote(input.directory);
	const git = `git -C ${dest}`;
	const start = input.pinnedRevision ?? "FETCH_HEAD";
	const pinned = input.pinnedRevision
		? `${git} cat-file -e ${quote(`${input.pinnedRevision}^{commit}`)} || { echo 'The pinned commit is not in the fetched branch.' >&2; exit 1; }\n`
		: "";
	const working = quote(input.workingBranch);
	const origin = quote(input.originUrl);
	// A fetch by URL moves no remote-tracking ref. The changes panel diffs
	// against the merge base with origin/<branch>, so a checkout restored from
	// an older snapshot counted every newer upstream commit as the chat's own.
	const tracking = `${git} update-ref ${quote(`refs/remotes/origin/${input.branch}`)} FETCH_HEAD`;
	if (input.mode === "clone")
		return `${pinned}${tracking}
${git} -c core.hooksPath=/dev/null checkout -b ${working} ${start}
${git} remote add origin ${origin}
${git} update-ref refs/ytimesy/base ${start}`;
	if (input.mode === "switch")
		return `${pinned}${tracking}
${switchBrokeredBranchCommand(input.directory, input.workingBranch, start)}
${git} update-ref refs/ytimesy/base ${start}`;
	// The chat's base moves with a fast-forward only while the checkout has
	// nothing of its own: its HEAD was its base and now is the fetched commit.
	return `${pinned}${tracking}
before=$(${git} rev-parse HEAD)
previous_base=$(${git} rev-parse -q --verify refs/ytimesy/base || true)
${git} -c core.hooksPath=/dev/null merge --ff-only ${start}
${git} -c core.hooksPath=/dev/null checkout -B ${working}
if [ "$previous_base" = "$before" ] && [ "$(${git} rev-parse HEAD)" = "$(${git} rev-parse ${start})" ]; then
  ${git} update-ref refs/ytimesy/base ${start}
fi
${git} remote set-url origin ${origin} 2>/dev/null || ${git} remote add origin ${origin}`;
}

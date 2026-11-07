/**
 * What a production deploy may build from: exactly the commit `origin/main`
 * points at, with no changed tracked files. A checkout left on an old or
 * detached commit once shipped code 99 commits behind main; the deploy built
 * whatever was checked out. Untracked files do not matter: they are not built.
 */
export type DeploySource = {
	/** The checked-out commit (git rev-parse HEAD). */
	head: string;
	/** The commit origin/main points at after a fetch. */
	originMain: string;
	/** Changed tracked files (git status --porcelain --untracked-files=no), one per line. */
	trackedChanges: string;
};

export function deploySourceProblem(source: DeploySource): string | null {
	const head = source.head.trim();
	const originMain = source.originMain.trim();
	if (!head || !originMain)
		return "Could not read the checked-out commit or origin/main.";
	if (head !== originMain)
		return `This checkout is at ${head.slice(0, 8)}, not origin/main (${originMain.slice(0, 8)}). Check out main, pull, then deploy. Pass --allow-unverified-source only for a deliberate hotfix.`;
	const changed = source.trackedChanges
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (changed.length)
		return `This checkout has changed tracked files (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", ..." : ""}). Commit or discard them, then deploy.`;
	return null;
}

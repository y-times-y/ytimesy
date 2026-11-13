import { execFileSync } from "node:child_process";

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

/**
 * What any production web build may be made from: a commit that already
 * contains origin/main. Weaker than deploySourceProblem on purpose, so a
 * feature branch on top of main can still be build-checked, but it stops the
 * case deploySourceProblem cannot see: a hand-rolled deploy that skips
 * deploy-production.ts. One built from an unpushed commit that lacked main's
 * latest work replaced the live composer fix (2026-11-12).
 */
export type BuildSource = {
	/** The checked-out commit (git rev-parse HEAD). */
	head: string;
	/** The commit origin/main points at after a fetch; empty when unreadable. */
	originMain: string;
	/** Whether origin/main is HEAD or one of its ancestors. */
	containsOriginMain: boolean;
};

export const ALLOW_UNVERIFIED_SOURCE_VARIABLE =
	"YTIMESY_ALLOW_UNVERIFIED_SOURCE";

export function productionBuildSourceProblem(
	source: BuildSource,
): string | null {
	const head = source.head.trim();
	const originMain = source.originMain.trim();
	if (!head || !originMain)
		return `Could not read the checked-out commit or fetch origin/main, so this production build cannot prove it includes the live code. Fix git access, or set ${ALLOW_UNVERIFIED_SOURCE_VARIABLE}=1 for a deliberate hotfix.`;
	if (!source.containsOriginMain)
		return `This checkout (${head.slice(0, 8)}) does not contain origin/main (${originMain.slice(0, 8)}); a production build from it would undo work already on main. Merge or rebase onto origin/main, then build. Set ${ALLOW_UNVERIFIED_SOURCE_VARIABLE}=1 only for a deliberate hotfix.`;
	return null;
}

/** Fetches origin/main and reads where this checkout stands against it. */
export function readBuildSource(): BuildSource {
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const attempt = (read: () => string) => {
		try {
			return read();
		} catch {
			return "";
		}
	};
	const head = attempt(() => git("rev-parse", "HEAD"));
	const originMain = attempt(() => {
		git("fetch", "--quiet", "origin", "main");
		return git("rev-parse", "origin/main");
	});
	// merge-base --is-ancestor answers by exit code: 0 yes, 1 no.
	const containsOriginMain =
		Boolean(head && originMain) &&
		attempt(() => {
			git("merge-base", "--is-ancestor", originMain, head);
			return "yes";
		}) === "yes";
	return { head, originMain, containsOriginMain };
}

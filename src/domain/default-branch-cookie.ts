/**
 * Each repository's default branch as this browser last read it from GitHub,
 * by repository id. A cookie, so the server renders a new chat's "from
 * <branch>" with it: a project saved on an agent's own branch otherwise
 * painted that branch, then swapped to the default once GitHub answered.
 */
export const DEFAULT_BRANCH_COOKIE = "ytimesy-branches";

/** Repositories kept, most recently read first. */
const KEPT = 20;
const ID = /^\d{1,15}$/;
/** Git allows more; this is what a cookie value holds without encoding. */
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

export type SavedDefaultBranches = Readonly<Record<string, string>>;

export const NO_SAVED_DEFAULT_BRANCHES: SavedDefaultBranches = {};

export function savedDefaultBranchesFromCookies(
	header: string | null | undefined,
): SavedDefaultBranches {
	const raw = header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${DEFAULT_BRANCH_COOKIE}=`))
		?.slice(DEFAULT_BRANCH_COOKIE.length + 1);
	if (!raw) return {};
	const saved: Record<string, string> = {};
	for (const entry of raw.split("!").slice(0, KEPT)) {
		const [id, branch] = entry.split("~");
		if (id && branch && ID.test(id) && BRANCH.test(branch) && !saved[id])
			saved[id] = branch;
	}
	return saved;
}

/** The cookie with this repository's default first; null when nothing changes or it cannot be stored. */
export function savedDefaultBranchCookie(
	saved: SavedDefaultBranches,
	repositoryId: number,
	branch: string,
): string | null {
	const id = String(repositoryId);
	if (!ID.test(id) || !BRANCH.test(branch) || saved[id] === branch) return null;
	const value = [
		`${id}~${branch}`,
		...Object.entries(saved)
			.filter(([key]) => key !== id)
			.map(([key, name]) => `${key}~${name}`),
	]
		.slice(0, KEPT)
		.join("!");
	return `${DEFAULT_BRANCH_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
}

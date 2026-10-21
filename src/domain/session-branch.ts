const SESSION_BRANCH_PREFIX = "ytimesy";
const SESSION_BRANCH_SLUG_MAX_LENGTH = 24;
const SESSION_BRANCH_ID_LENGTH = 6;
/** A whole chat branch name, prefix and collision suffix included. */
export const SESSION_BRANCH_MAX_LENGTH = 40;

export function isGeneratedSessionBranch(name: string): boolean {
	const branch = name.trim();
	return (
		branch === SESSION_BRANCH_PREFIX ||
		branch.startsWith(`${SESSION_BRANCH_PREFIX}/`)
	);
}

/** The first words of the text: lowercase a-z0-9 runs joined by single hyphens, cut at a word boundary. */
function sessionBranchSlug(text: string, maxLength: number): string {
	const slug = text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= maxLength) return slug || "chat";
	const shortened = slug.slice(0, maxLength);
	if (slug[maxLength] === "-") return shortened;
	const wordBoundary = shortened.lastIndexOf("-");
	return wordBoundary > 0 ? shortened.slice(0, wordBoundary) : shortened;
}

/** Six lowercase base36/hex characters of the chat id. */
function sessionBranchSuffix(id: string): string {
	const trimmed = id.trim();
	const width = SESSION_BRANCH_ID_LENGTH;
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed).toString(16).padStart(width, "0").slice(-width);
	}
	const hex = trimmed.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
	if (hex.length >= width) return hex.slice(-width);
	const compact = trimmed.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	return compact.padStart(width, "0").slice(-width);
}

/**
 * `ytimesy/<slug>-<id>`, at most 40 characters. `attempt` > 0 adds a short
 * suffix (`-2`, `-3`, ...) for a name another chat already holds.
 */
export function sessionBranchName(input: {
	readonly title?: string;
	readonly id: string;
	readonly attempt?: number;
}): string {
	const attempt = Math.max(0, Math.floor(input.attempt ?? 0));
	const collision = attempt > 0 ? `-${(attempt + 1).toString(36)}` : "";
	const suffix = `-${sessionBranchSuffix(input.id)}${collision}`;
	const slugBudget = Math.min(
		SESSION_BRANCH_SLUG_MAX_LENGTH,
		SESSION_BRANCH_MAX_LENGTH -
			SESSION_BRANCH_PREFIX.length -
			1 -
			suffix.length,
	);
	return `${SESSION_BRANCH_PREFIX}/${sessionBranchSlug(input.title ?? "", slugBudget)}${suffix}`;
}

export function sessionWorkingBranch(input: {
	readonly selectedBranch: string;
	readonly defaultBranch?: string;
	readonly title?: string;
	readonly id?: string;
}): string {
	const selected = input.selectedBranch.trim();
	if (isGeneratedSessionBranch(selected) && selected.includes("/")) {
		return selected;
	}
	const onDefault =
		!selected ||
		selected === SESSION_BRANCH_PREFIX ||
		Boolean(input.defaultBranch && selected === input.defaultBranch.trim());
	if (onDefault) {
		return sessionBranchName({
			title: input.title,
			id: input.id?.trim() || selected || "workspace",
		});
	}
	return selected;
}

export function sessionCloneBranch(input: {
	readonly selectedBranch: string;
	readonly defaultBranch?: string;
	readonly title?: string;
	readonly id?: string;
}): string {
	const working = sessionWorkingBranch(input);
	if (!isGeneratedSessionBranch(working)) return input.selectedBranch.trim();
	const fallback = input.defaultBranch?.trim();
	if (fallback && !isGeneratedSessionBranch(fallback)) return fallback;
	const selected = input.selectedBranch.trim();
	if (selected && !isGeneratedSessionBranch(selected)) return selected;
	return "";
}

export function sessionBranchChangeRestartsWorkspace(input: {
	readonly from: string;
	readonly to: string;
	readonly defaultBranch?: string;
	readonly title?: string;
	readonly id?: string;
}): boolean {
	return (
		sessionWorkingBranch({
			selectedBranch: input.from,
			defaultBranch: input.defaultBranch,
			title: input.title,
			id: input.id,
		}) !==
		sessionWorkingBranch({
			selectedBranch: input.to,
			defaultBranch: input.defaultBranch,
			title: input.title,
			id: input.id,
		})
	);
}

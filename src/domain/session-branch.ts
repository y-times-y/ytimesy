export const SESSION_BRANCH_PREFIX = "ytimesy";
const SESSION_BRANCH_SLUG_MAX_LENGTH = 24;

export function isGeneratedSessionBranch(name: string): boolean {
	const branch = name.trim();
	return (
		branch === SESSION_BRANCH_PREFIX ||
		branch.startsWith(`${SESSION_BRANCH_PREFIX}/`)
	);
}

export function sessionBranchSlug(text: string): string {
	const slug = text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= SESSION_BRANCH_SLUG_MAX_LENGTH) return slug || "workspace";
	const shortened = slug.slice(0, SESSION_BRANCH_SLUG_MAX_LENGTH);
	const wordBoundary = shortened.lastIndexOf("-");
	if (slug[SESSION_BRANCH_SLUG_MAX_LENGTH] === "-") return shortened;
	return wordBoundary > 0 ? shortened.slice(0, wordBoundary) : shortened;
}

export function sessionBranchSuffix(id: string): string {
	const trimmed = id.trim();
	if (/^\d+$/.test(trimmed)) {
		return Number(trimmed).toString(16).padStart(4, "0").slice(-4);
	}
	const hex = trimmed.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
	if (hex.length >= 4) return hex.slice(-4);
	const compact = trimmed.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	return compact.padStart(4, "0").slice(-4);
}

export function sessionBranchName(input: {
	readonly title?: string;
	readonly id: string;
}): string {
	return `${SESSION_BRANCH_PREFIX}/${sessionBranchSlug(input.title ?? "")}-${sessionBranchSuffix(input.id)}`;
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

export function listedSessionBranches(input: {
	readonly remoteBranches: readonly string[];
	readonly workingBranch?: string;
}): string[] {
	const remotes = input.remoteBranches
		.map((branch) => branch.trim())
		.filter((branch) => branch && branch !== SESSION_BRANCH_PREFIX);
	const working = input.workingBranch?.trim();
	return [
		...new Set([
			...(working && isGeneratedSessionBranch(working) ? [working] : []),
			...remotes,
		]),
	];
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

export function canSelectSessionBranch(input: {
	readonly branch: string;
	readonly remoteBranches: readonly string[];
}): boolean {
	return (
		isGeneratedSessionBranch(input.branch) ||
		input.remoteBranches.includes(input.branch)
	);
}

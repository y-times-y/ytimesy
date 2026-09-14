export type BranchComparison = {
	head: string;
	base: string;
	aheadBy: number;
};

export function publicationBlockedReason(
	comparison: BranchComparison,
): string | null {
	if (comparison.head === comparison.base)
		return "Choose a branch with commits that are not already on the base branch.";
	if (comparison.aheadBy < 1)
		return "Nothing to publish. The branch has no commits ahead of the base.";
	return null;
}

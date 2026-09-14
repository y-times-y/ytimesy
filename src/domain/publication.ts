import {
	type ProjectWorkspace,
	workspaceSessionMachineRef,
} from "./project-workspace";

export type BranchComparison = {
	head: string;
	base: string;
	aheadBy: number;
};

export type PublicationAuthor = {
	readonly name: string;
	readonly email: string;
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

export function publicationWorkspaceBlockedReason(
	workspace:
		| (Pick<ProjectWorkspace, "status" | "providerRef"> & {
				errorMessage?: string | null;
		  })
		| null,
) {
	if (workspaceSessionMachineRef(workspace)) return null;
	if (!workspace) return "Prepare a workspace before publishing.";
	if (workspace.status === "failed")
		return (
			workspace.errorMessage ??
			"Workspace preparation failed. Retry, then publish."
		);
	return "Wait for workspace preparation to finish before publishing.";
}

export function publicationCommitAuthor(user: {
	readonly name?: string | null;
	readonly email?: string | null;
}): PublicationAuthor {
	const email = user.email?.trim() || "noreply@ytimesy.com";
	const name = user.name?.trim() || email.split("@")[0] || "ytimesy";
	return { name, email };
}

export function workspacePublicationBranch(workspaceId: string) {
	const compact = workspaceId.replaceAll("-", "").slice(0, 12).toLowerCase();
	return `ytimesy-${compact || "workspace"}`;
}

export function publicationHeadBranch(input: {
	readonly selectedBranch: string;
	readonly defaultBranch: string;
	readonly workspaceId: string;
}) {
	if (input.selectedBranch === input.defaultBranch)
		return workspacePublicationBranch(input.workspaceId);
	return input.selectedBranch;
}

import { workspacePublicationBranch } from "./publication";
import {
	type PullRequestChecksSummary,
	type SidebarPullRequest,
	sidebarPullRequest,
} from "./sidebar-chat-status";

export type SidebarChatPrNeed =
	| "ready"
	| "merged"
	| "pending"
	| "conflict"
	| "blocked"
	| "checks_failed"
	| "draft"
	| "closed";

export type ListedPullRequest = {
	readonly number: number;
	readonly url: string;
	readonly head: string;
	readonly draft: boolean;
	readonly state: string;
	readonly merged: boolean;
	readonly mergeable: boolean | null;
	readonly mergeableState: string | null;
	/** The head's check results; listed only for open and draft pull requests. */
	readonly checks?: PullRequestChecksSummary | null;
};

type SidebarChatPrMark = {
	readonly need: SidebarChatPrNeed;
	readonly url: string;
	readonly label: string;
	readonly pr: SidebarPullRequest;
};

export function sidebarChatPrNeedFromPullRequest(pr: {
	readonly draft: boolean;
	readonly state: string;
	readonly merged: boolean;
	readonly mergeable: boolean | null;
	readonly mergeableState: string | null;
	/** The head's check runs and statuses, when they were read. */
	readonly checks?: PullRequestChecksSummary | null;
}): SidebarChatPrNeed {
	if (pr.merged) return "merged";
	if (pr.state === "closed") return "closed";
	const mergeableState = pr.mergeableState?.trim().toLowerCase() ?? "";
	if (pr.mergeable === false || mergeableState === "dirty") return "conflict";
	if (mergeableState === "blocked" || mergeableState === "behind") {
		return "blocked";
	}
	// GitHub says "unstable" for any non-passing status: pending ones too, and
	// check suites other Apps queue on every push even where no CI is
	// configured. Only a check that actually failed reads as failed.
	if (mergeableState === "unstable") {
		if (!pr.checks || pr.checks.failed > 0) return "checks_failed";
		if (pr.draft) return "draft";
		if (pr.checks.pending > 0) return "pending";
		return pr.mergeable === true ? "ready" : "pending";
	}
	if (pr.draft || mergeableState === "draft") return "draft";
	if (
		pr.state === "open" &&
		pr.mergeable === true &&
		mergeableState === "clean"
	)
		return "ready";
	return "pending";
}

export function sidebarChatPrNeedLabel(need: SidebarChatPrNeed) {
	if (need === "ready") return "Ready to merge";
	if (need === "merged") return "Pull request merged";
	if (need === "pending") return "Merge readiness not confirmed";
	if (need === "conflict") return "Has merge conflicts";
	if (need === "blocked") return "Cannot be merged";
	if (need === "checks_failed") return "Checks failed";
	if (need === "draft") return "Draft pull request";
	return "Pull request closed";
}

export function sidebarChatPrMarkForWorkspace(input: {
	readonly workspaceId?: string | null;
	readonly workingBranch?: string | null;
	readonly pullRequests: readonly ListedPullRequest[];
}): SidebarChatPrMark | null {
	const workspaceId = input.workspaceId?.trim();
	const head =
		input.workingBranch?.trim() ||
		(workspaceId ? workspacePublicationBranch(workspaceId) : null);
	if (!head) return null;
	const pullRequest = input.pullRequests.find(
		(row) => row.head === head || row.head.endsWith(`:${head}`),
	);
	if (!pullRequest) return null;
	const need = sidebarChatPrNeedFromPullRequest(pullRequest);
	return {
		need,
		url: pullRequest.url,
		label: sidebarChatPrNeedLabel(need),
		pr: sidebarPullRequest(pullRequest),
	};
}

type PullRequestRepositoryRef = {
	readonly installationId: number;
	readonly repositoryId: number;
	readonly fullName: string;
};

export type RepositoryPullRequest = ListedPullRequest & {
	readonly installationId: number;
	readonly repositoryId: number;
	readonly repositoryFullName: string;
};

/**
 * One list across all of a project's repositories, primary first, so a chat's
 * pull request shows even when the agent opened it in a secondary repository.
 */
export function pullRequestsAcrossRepositories(
	lists: readonly {
		readonly repository: PullRequestRepositoryRef;
		readonly pullRequests?: readonly ListedPullRequest[];
	}[],
): RepositoryPullRequest[] {
	return lists.flatMap(({ repository, pullRequests }) =>
		(pullRequests ?? []).map((pr) => ({
			...pr,
			installationId: repository.installationId,
			repositoryId: repository.repositoryId,
			repositoryFullName: repository.fullName,
		})),
	);
}

/** The repository the pull request panel opens: the chat's own PR's, else the primary one. */
export function pullRequestPanelRepository(input: {
	readonly repositories: readonly PullRequestRepositoryRef[];
	readonly chatPullRequest?: RepositoryPullRequest;
}):
	| {
			readonly installationId: number;
			readonly repositoryId: number;
			readonly number?: number;
	  }
	| undefined {
	if (input.chatPullRequest)
		return {
			installationId: input.chatPullRequest.installationId,
			repositoryId: input.chatPullRequest.repositoryId,
			number: input.chatPullRequest.number,
		};
	const primary = input.repositories[0];
	if (!primary?.installationId || !primary.repositoryId) return undefined;
	return {
		installationId: primary.installationId,
		repositoryId: primary.repositoryId,
	};
}

/**
 * A chat's saved PR (sidebar cookie) as a listed one, shown until the live
 * list is read. A mark saved before merge answers were kept reads as not
 * confirmed.
 */
export function savedListedPullRequest(
	saved: SidebarPullRequest,
	head: string,
): ListedPullRequest {
	return {
		number: saved.number,
		url: saved.url,
		head,
		draft: saved.state === "draft",
		state:
			saved.state === "merged" || saved.state === "closed" ? "closed" : "open",
		merged: saved.state === "merged",
		mergeable:
			saved.merge === "conflict"
				? false
				: saved.merge === "ready"
					? true
					: null,
		mergeableState:
			saved.merge === "ready"
				? "clean"
				: saved.merge === "blocked"
					? "blocked"
					: saved.checks === "failed"
						? "unstable"
						: null,
	};
}

/** An open PR GitHub has not yet said it can or cannot merge (it computes that after the first read). */
export function mergeAnswerPending(pr: ListedPullRequest): boolean {
	return (
		pr.state === "open" &&
		!pr.merged &&
		!pr.draft &&
		(pr.mergeable === null ||
			(pr.mergeableState?.trim().toLowerCase() ?? "unknown") === "unknown")
	);
}

import type { IssueState, IssueSummary } from "#/domain/github-issues";
import type {
	PullRequestFilter,
	RepositoryPullRequest,
} from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";

/**
 * The reads behind the pull request and issue tables, in a module of their own
 * so the sidebar's badge can share their cache without loading the tables.
 */
type Repository = {
	readonly installationId: number;
	readonly repositoryId: number;
};
export type IssueFilter = IssueState | "all";

const params = (repository: Repository, extra: Record<string, string>) =>
	new URLSearchParams({
		installationId: String(repository.installationId),
		repositoryId: String(repository.repositoryId),
		...extra,
	});

export const pullRequestsKey = (
	repositoryId: number,
	filter: PullRequestFilter,
) => ["pull-requests", repositoryId, filter] as const;

export const pullRequestsRequest = (
	repository: Repository,
	filter: PullRequestFilter,
) =>
	requestJson<{ pullRequests: RepositoryPullRequest[] }>(
		`/api/github/pull-request?${params(repository, { state: filter })}`,
	);

export const issuesKey = (repositoryId: number, filter: IssueFilter) =>
	["issues", repositoryId, filter] as const;

export const issuesRequest = (repository: Repository, filter: IssueFilter) =>
	requestJson<{ issues: IssueSummary[] }>(
		`/api/github/issue?${params(repository, { state: filter })}`,
	);

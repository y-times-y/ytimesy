import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
	ListedRepositoryPullRequest,
	PullRequestDetail,
} from "#/domain/pull-request-review";
import type { ListedPullRequest } from "#/domain/sidebar-pr";
import { requestJson } from "../projects/api";

export type PullRequestSource = {
	readonly installationId: number;
	readonly repositoryId: number;
	readonly number: number;
};

/** What a list already knows about a pull request, shown before its details arrive. */
export type PullRequestSummary = {
	readonly number: number;
	readonly title?: string;
	readonly url?: string;
	readonly state?: PullRequestDetail["state"];
	readonly head?: string;
	readonly base?: string;
	readonly author?: string;
	readonly authorAvatarUrl?: string | null;
	readonly additions?: number;
	readonly deletions?: number;
	readonly changedFiles?: number;
};

/** Details read within this long are shown without asking GitHub again. */
export const PULL_REQUEST_DETAIL_FRESH_MS = 10_000;

/** Reads in flight by URL: a prefetch and the panel opening share one request. */
const reading = new Map<string, Promise<PullRequestDetail>>();

export function readPullRequestDetail(
	source: PullRequestSource,
	request: (path: string) => Promise<PullRequestDetail> = requestJson,
) {
	const path = `/api/github/pull-request?${new URLSearchParams({
		installationId: String(source.installationId),
		repositoryId: String(source.repositoryId),
		number: String(source.number),
	})}`;
	const pending = reading.get(path);
	if (pending) return pending;
	const read = request(path).finally(() => reading.delete(path));
	reading.set(path, read);
	return read;
}

export function pullRequestDetailKey(source: PullRequestSource) {
	return ["pull-request", source.repositoryId, source.number] as const;
}

/** The one query the panel and every prefetch use, so they share a cache entry. */
export function pullRequestDetailQuery(source: PullRequestSource) {
	return queryOptions({
		queryKey: pullRequestDetailKey(source),
		queryFn: () => readPullRequestDetail(source),
		staleTime: PULL_REQUEST_DETAIL_FRESH_MS,
	});
}

/** Reads a pull request's details ahead of the panel; a fresh copy is not read again. */
export function prefetchPullRequestDetail(
	client: QueryClient,
	source: PullRequestSource,
) {
	void client.prefetchQuery(pullRequestDetailQuery(source));
}

/** A chat's pull request from the Overview's list, as the panel's first paint. */
export function listedPullRequestSummary(
	pr: ListedPullRequest,
): PullRequestSummary {
	return {
		number: pr.number,
		title: pr.title,
		url: pr.url,
		state: pr.merged
			? "merged"
			: pr.state === "closed"
				? "closed"
				: pr.draft
					? "draft"
					: "open",
		head: pr.head,
		base: pr.base,
		author: pr.author,
		authorAvatarUrl: pr.authorAvatarUrl,
		additions: pr.additions,
		deletions: pr.deletions,
		changedFiles: pr.changedFiles,
	};
}

/** A row of the panel's open pull request picker, as the panel's first paint. */
export function pickedPullRequestSummary(
	pr: ListedRepositoryPullRequest,
): PullRequestSummary {
	return {
		number: pr.number,
		title: pr.title,
		url: pr.url,
		state: pr.draft ? "draft" : "open",
		author: pr.author,
		authorAvatarUrl: pr.authorAvatarUrl,
	};
}

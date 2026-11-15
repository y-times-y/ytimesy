import {
	checksCountFrom,
	type PullRequestFilter,
	type PullRequestPerson,
	pullRequestPerson,
	type RepositoryPullRequest,
	reviewMarkFrom,
} from "../../../domain/pull-request-review";
import { githubClient, repositoryOwnerName, signedInLogin } from "../github";

type Github = ReturnType<typeof githubClient>;

type GithubUserNode = { login: string; avatarUrl: string | null } | null;
type SignalsPage = {
	repository: {
		pullRequests: {
			nodes: {
				number: number;
				additions: number;
				deletions: number;
				latestOpinionatedReviews: {
					nodes: { state: string; author: GithubUserNode }[];
				};
				reviewRequests: {
					nodes: {
						requestedReviewer:
							| ({ __typename: string } & Partial<NonNullable<GithubUserNode>>)
							| null;
					}[];
				};
				commits: {
					nodes: {
						commit: {
							statusCheckRollup: {
								contexts: {
									nodes: {
										__typename: string;
										status?: string;
										conclusion?: string | null;
										state?: string;
									}[];
								};
							} | null;
						};
					}[];
				};
			}[];
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	} | null;
};

const SIGNALS_QUERY = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 100, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }, after: $after) {
      nodes {
        number additions deletions
        latestOpinionatedReviews(first: 5) { nodes { state author { login avatarUrl } } }
        reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 60) { nodes {
          __typename
          ... on CheckRun { status conclusion }
          ... on StatusContext { state }
        } } } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const person = (user: GithubUserNode): PullRequestPerson =>
	pullRequestPerson(
		user
			? { login: user.login, avatar_url: user.avatarUrl ?? undefined }
			: null,
	);

/**
 * The review, check and size signals of the open pull requests, read for the
 * whole list in as few GraphQL calls as it takes. Empty when GitHub refuses
 * (the table then simply shows no such columns), never an error: the list
 * itself must still load.
 */
async function openPullRequestSignals(
	github: Github,
	owner: string,
	repo: string,
) {
	const signals = new Map<
		number,
		Pick<RepositoryPullRequest, "review" | "checks" | "additions" | "deletions">
	>();
	try {
		const viewer = await signedInLogin(github);
		let after: string | null = null;
		for (let page = 0; page < 5; page++) {
			const result: SignalsPage = await github.graphql<SignalsPage>(
				SIGNALS_QUERY,
				{ owner, repo, after },
			);
			const pulls = result.repository?.pullRequests;
			if (!pulls) break;
			for (const node of pulls.nodes) {
				const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
				signals.set(node.number, {
					additions: node.additions,
					deletions: node.deletions,
					checks: checksCountFrom(
						(rollup?.contexts.nodes ?? []).map((result) => ({
							status: result.status,
							conclusion: result.conclusion,
							state: result.state,
						})),
					),
					review: reviewMarkFrom({
						decisions: node.latestOpinionatedReviews.nodes
							.filter((review) => review.author)
							.map((review) => ({
								state: review.state,
								person: person(review.author),
							})),
						requested: node.reviewRequests.nodes.flatMap((request) =>
							request.requestedReviewer?.__typename === "User" &&
							request.requestedReviewer.login
								? [
										person({
											login: request.requestedReviewer.login,
											avatarUrl: request.requestedReviewer.avatarUrl ?? null,
										}),
									]
								: [],
						),
						viewer,
					}),
				});
			}
			if (!pulls.pageInfo.hasNextPage) break;
			after = pulls.pageInfo.endCursor;
		}
	} catch {
		// The table shows without them.
	}
	return signals;
}

/** All matching PRs, not just GitHub's first page. Closed excludes merged PRs. */
export async function listRepositoryPullRequests(
	token: string,
	fullName: string,
	filter: PullRequestFilter,
): Promise<RepositoryPullRequest[]> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const pulls = await github.paginate(github.pulls.list, {
		owner,
		repo,
		state: filter === "merged" ? "closed" : filter,
		sort: "updated",
		direction: "desc",
		per_page: 100,
	});
	// Open pull requests only: a merged or closed one has no review to ask for.
	const signals =
		filter === "open" || filter === "all"
			? await openPullRequestSignals(github, owner, repo)
			: new Map();
	return pulls
		.filter((pull) =>
			filter === "merged"
				? Boolean(pull.merged_at)
				: filter === "closed"
					? !pull.merged_at
					: true,
		)
		.map((pull) => ({
			number: pull.number,
			title: pull.title,
			url: pull.html_url,
			author: pull.user?.login ?? "ghost",
			authorName: null,
			authorAvatarUrl: pull.user?.avatar_url ?? null,
			draft: Boolean(pull.draft),
			state: pull.merged_at
				? "merged"
				: pull.state === "closed"
					? "closed"
					: pull.draft
						? "draft"
						: "open",
			head: pull.head.ref,
			base: pull.base.ref,
			updatedAt: pull.updated_at,
			labels: pull.labels.map((label) => ({
				name: label.name ?? "",
				color: label.color ?? "777777",
				description: label.description ?? null,
			})),
			...(pull.state === "open" ? signals.get(pull.number) : {}),
		}));
}

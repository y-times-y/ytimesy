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
type CheckResult = {
	status?: string;
	conclusion?: string | null;
	state?: string;
};
type ChecksPage = {
	repository: {
		pullRequests: {
			nodes: {
				number: number;
				commits: {
					nodes: {
						commit: {
							statusCheckRollup: {
								contexts: { nodes: (CheckResult & { __typename: string })[] };
							} | null;
						};
					}[];
				};
			}[];
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	} | null;
};
type SignalsPage = {
	repository: {
		pullRequests: {
			nodes: {
				number: number;
				additions: number;
				deletions: number;
				headRefOid: string;
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
			}[];
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	} | null;
};

const SIGNALS_QUERY = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 100, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }, after: $after) {
      nodes {
        number additions deletions headRefOid
        latestOpinionatedReviews(first: 5) { nodes { state author { login avatarUrl } } }
        reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** Check results by pull request number, in a query of their own so a refusal never costs the review and size columns. */
const CHECKS_QUERY = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 50, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }, after: $after) {
      nodes {
        number
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
	const heads = new Map<number, string>();
	const signals = new Map<
		number,
		{
			review: RepositoryPullRequest["review"];
			checks: RepositoryPullRequest["checks"];
			additions: number;
			deletions: number;
		}
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
				heads.set(node.number, node.headRefOid);
				signals.set(node.number, {
					additions: node.additions,
					deletions: node.deletions,
					checks: null,
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
	} catch (error) {
		console.warn("Pull request review signals unavailable", errorText(error));
	}
	await fillChecks(github, owner, repo, signals, heads);
	return signals;
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const CHECK_FALLBACK_LIMIT = 30;

/**
 * Check results for the open pull requests: GraphQL's rollup in one read, then
 * GitHub's REST check runs and commit statuses (the reads the review panel
 * uses) for whichever pull request the rollup left without. Each step is
 * allowed to fail on its own.
 */
async function fillChecks(
	github: Github,
	owner: string,
	repo: string,
	signals: Map<number, { checks: RepositoryPullRequest["checks"] }>,
	heads: ReadonlyMap<number, string>,
) {
	try {
		let after: string | null = null;
		for (let page = 0; page < 6; page++) {
			const result: ChecksPage = await github.graphql<ChecksPage>(
				CHECKS_QUERY,
				{ owner, repo, after },
			);
			const pulls = result.repository?.pullRequests;
			if (!pulls) break;
			for (const node of pulls.nodes) {
				const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
				const entry = signals.get(node.number);
				if (entry && rollup)
					entry.checks = checksCountFrom(rollup.contexts.nodes);
			}
			if (!pulls.pageInfo.hasNextPage) break;
			after = pulls.pageInfo.endCursor;
		}
	} catch (error) {
		console.warn("Pull request check rollup unavailable", errorText(error));
	}
	const missing = [...heads]
		.filter(([number]) => !signals.get(number)?.checks)
		.slice(0, CHECK_FALLBACK_LIMIT);
	for (let start = 0; start < missing.length; start += 6) {
		await Promise.all(
			missing.slice(start, start + 6).map(async ([number, ref]) => {
				const [runs, statuses] = await Promise.all([
					github.rest.checks
						.listForRef({ owner, repo, ref, per_page: 100 })
						.then((response) => response.data.check_runs)
						.catch(() => []),
					github.rest.repos
						.getCombinedStatusForRef({ owner, repo, ref })
						.then((response) => response.data.statuses)
						.catch(() => []),
				]);
				const entry = signals.get(number);
				if (entry)
					entry.checks = checksCountFrom([
						...runs.map((run) => ({
							status: run.status.toUpperCase(),
							conclusion: run.conclusion?.toUpperCase() ?? null,
						})),
						...statuses.map((status) => ({
							state: status.state.toUpperCase(),
						})),
					]);
			}),
		);
	}
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

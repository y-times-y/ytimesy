import type {
	PullRequestFilter,
	RepositoryPullRequest,
} from "../../../domain/pull-request-review";
import { githubClient, repositoryOwnerName } from "../github";

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
		}));
}

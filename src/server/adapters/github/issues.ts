import type {
	IssueDetail,
	IssueLinkedPullRequest,
	IssueState,
	IssueSummary,
	IssueWriteAction,
} from "../../../domain/github-issues";
import { pullRequestPerson } from "../../../domain/pull-request-review";
import { githubClient, repositoryOwnerName, signedInLogin } from "../github";
import {
	changeAssignees,
	githubWrite,
	requireCommentOnItem,
} from "./pull-request-actions";

type Github = ReturnType<typeof githubClient>;
type GithubIssue = Awaited<ReturnType<Github["issues"]["get"]>>["data"];

function issueSummary(issue: GithubIssue): IssueSummary {
	return {
		number: issue.number,
		title: issue.title,
		url: issue.html_url,
		state: issue.state === "closed" ? "closed" : "open",
		stateReason: issue.state_reason ?? null,
		author: pullRequestPerson(issue.user),
		labels: issue.labels.flatMap((label) =>
			typeof label === "string"
				? [{ name: label, color: "777777", description: null }]
				: label.name
					? [
							{
								name: label.name,
								color: label.color ?? "777777",
								description: label.description ?? null,
							},
						]
					: [],
		),
		assignees: (issue.assignees ?? []).map(pullRequestPerson),
		comments: issue.comments,
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
	};
}

/** The repository's issues, newest activity first; pull requests are left out. */
export async function listIssues(
	token: string,
	fullName: string,
	state: IssueState | "all",
): Promise<IssueSummary[]> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const data = await github.paginate(github.issues.listForRepo, {
		owner,
		repo,
		state,
		sort: "updated",
		per_page: 100,
	});
	return data
		.filter((issue) => !issue.pull_request)
		.map((issue) => issueSummary(issue as GithubIssue));
}

/** Everything the Issues panel shows for one issue. */
export async function issueDetail(
	token: string,
	fullName: string,
	number: number,
): Promise<IssueDetail> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const [issue, comments, linked, viewer] = await Promise.all([
		github.issues.get({ owner, repo, issue_number: number }),
		github.paginate(github.issues.listComments, {
			owner,
			repo,
			issue_number: number,
			per_page: 100,
		}),
		closingPullRequests(github, owner, repo, number),
		signedInLogin(github),
	]);
	if (issue.data.pull_request)
		throw new Response(
			JSON.stringify({ error: "This is a pull request, not an issue." }),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	return {
		...issueSummary(issue.data),
		body: issue.data.body ?? "",
		conversation: comments.map((comment) => ({
			id: comment.id,
			author: pullRequestPerson(comment.user),
			body: comment.body ?? "",
			createdAt: comment.created_at,
			url: comment.html_url,
		})),
		linkedPullRequests: linked,
		viewer,
	};
}

/** Pull requests that close the issue when merged; empty when GitHub won't say. */
async function closingPullRequests(
	github: Github,
	owner: string,
	repo: string,
	number: number,
): Promise<IssueLinkedPullRequest[]> {
	try {
		const result = await github.graphql<{
			repository: {
				issue: {
					closedByPullRequestsReferences: {
						nodes: {
							number: number;
							title: string;
							url: string;
							state: "OPEN" | "CLOSED" | "MERGED";
						}[];
					};
				} | null;
			} | null;
		}>(
			"query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title url state } } } } }",
			{ owner, repo, number },
		);
		return (
			result.repository?.issue?.closedByPullRequestsReferences.nodes ?? []
		).map((pull) => ({
			number: pull.number,
			title: pull.title,
			url: pull.url,
			state:
				pull.state === "MERGED"
					? "merged"
					: pull.state === "CLOSED"
						? "closed"
						: "open",
		}));
	} catch {
		return [];
	}
}

/**
 * Applies one change to the repository's issues with the signed-in user's
 * token; returns the issue it changed (a new one for create).
 */
export async function runIssueAction(
	token: string,
	fullName: string,
	input: IssueWriteAction,
): Promise<number> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	return githubWrite("Issues: write", async () => {
		switch (input.action) {
			case "create": {
				const created = await github.issues.create({
					owner,
					repo,
					title: input.title,
					body: input.body,
					...(input.labels.length ? { labels: [...input.labels] } : {}),
					...(input.assignees.length
						? { assignees: [...input.assignees] }
						: {}),
				});
				return created.data.number;
			}
			case "edit":
				await github.issues.update({
					owner,
					repo,
					issue_number: input.number,
					...(input.title !== undefined ? { title: input.title } : {}),
					...(input.body !== undefined ? { body: input.body } : {}),
				});
				return input.number;
			case "state":
				await github.issues.update({
					owner,
					repo,
					issue_number: input.number,
					state: input.state,
					...(input.state === "closed"
						? { state_reason: input.reason ?? "completed" }
						: { state_reason: "reopened" as const }),
				});
				return input.number;
			case "comment":
				await github.issues.createComment({
					owner,
					repo,
					issue_number: input.number,
					body: input.body,
				});
				return input.number;
			case "edit-comment":
				await requireCommentOnItem(
					github,
					{ owner, repo, number: input.number },
					"comment",
					input.commentId,
				);
				await github.issues.updateComment({
					owner,
					repo,
					comment_id: input.commentId,
					body: input.body,
				});
				return input.number;
			case "delete-comment":
				await requireCommentOnItem(
					github,
					{ owner, repo, number: input.number },
					"comment",
					input.commentId,
				);
				await github.issues.deleteComment({
					owner,
					repo,
					comment_id: input.commentId,
				});
				return input.number;
			case "labels":
				await github.issues.setLabels({
					owner,
					repo,
					issue_number: input.number,
					labels: [...input.labels],
				});
				return input.number;
			case "assignees":
				await changeAssignees(
					github,
					{ owner, repo, number: input.number },
					input,
				);
				return input.number;
		}
	});
}

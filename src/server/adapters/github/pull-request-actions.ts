import {
	type GithubWritePermission,
	githubWriteFailure,
	type PullRequestWriteAction,
	pullRequestActionPermission,
} from "../../../domain/github-write";
import {
	pullRequestPerson,
	type RepositoryChoices,
} from "../../../domain/pull-request-review";
import { githubClient, repositoryOwnerName } from "../github";

type Github = ReturnType<typeof githubClient>;

/**
 * Runs a GitHub change and turns its refusals into messages the user can act
 * on (a missing App permission, branch protection, a deleted comment).
 */
export async function githubWrite<T>(
	permission: GithubWritePermission,
	change: () => Promise<T>,
): Promise<T> {
	try {
		return await change();
	} catch (error) {
		if (error instanceof Response) throw error;
		const failure = githubWriteFailure(error, permission);
		if (failure)
			throw new Response(JSON.stringify({ error: failure.message }), {
				status: failure.status,
				headers: { "Content-Type": "application/json" },
			});
		throw error;
	}
}

/** Applies one change to a pull request with the signed-in user's token. */
export async function runPullRequestAction(
	token: string,
	fullName: string,
	number: number,
	input: PullRequestWriteAction,
): Promise<void> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	await githubWrite(pullRequestActionPermission(input.action), () =>
		pullRequestChange(github, { owner, repo, number }, input),
	);
}

async function pullRequestChange(
	github: Github,
	{ owner, repo, number }: { owner: string; repo: string; number: number },
	input: PullRequestWriteAction,
): Promise<unknown> {
	switch (input.action) {
		case "comment":
			return github.issues.createComment({
				owner,
				repo,
				issue_number: number,
				body: input.body,
			});
		case "reply":
			return github.pulls.createReplyForReviewComment({
				owner,
				repo,
				pull_number: number,
				comment_id: input.commentId,
				body: input.body,
			});
		case "edit-comment":
			await requireCommentOnItem(
				github,
				{ owner, repo, number },
				input.kind,
				input.commentId,
			);
			return input.kind === "comment"
				? github.issues.updateComment({
						owner,
						repo,
						comment_id: input.commentId,
						body: input.body,
					})
				: github.pulls.updateReviewComment({
						owner,
						repo,
						comment_id: input.commentId,
						body: input.body,
					});
		case "delete-comment":
			await requireCommentOnItem(
				github,
				{ owner, repo, number },
				input.kind,
				input.commentId,
			);
			return input.kind === "comment"
				? github.issues.deleteComment({
						owner,
						repo,
						comment_id: input.commentId,
					})
				: github.pulls.deleteReviewComment({
						owner,
						repo,
						comment_id: input.commentId,
					});
		case "resolve-thread": {
			const target = await github.graphql<{
				node: {
					pullRequest: {
						number: number;
						repository: { nameWithOwner: string };
					};
				} | null;
			}>(
				"query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }",
				{ id: input.threadId },
			);
			if (
				target.node?.pullRequest?.number !== number ||
				target.node.pullRequest.repository.nameWithOwner.toLowerCase() !==
					`${owner}/${repo}`.toLowerCase()
			)
				throw new Response("Review thread not found in this pull request.", {
					status: 404,
				});
			return github.graphql(
				input.resolved
					? "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }"
					: "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
				{ id: input.threadId },
			);
		}
		case "review":
			return github.pulls.createReview({
				owner,
				repo,
				pull_number: number,
				commit_id: input.headSha,
				event: input.event,
				// GitHub requires a body for these two; approval may be silent.
				...(input.body.trim() || input.event !== "APPROVE"
					? { body: input.body }
					: {}),
				comments: input.comments.map((comment) => ({
					path: comment.path,
					line: comment.line,
					side: comment.side,
					body: comment.body,
				})),
			});
		case "line-comment":
			return github.pulls.createReviewComment({
				owner,
				repo,
				pull_number: number,
				commit_id: input.headSha,
				path: input.path,
				line: input.line,
				side: input.side,
				body: input.body,
			});
		case "state":
			return github.pulls.update({
				owner,
				repo,
				pull_number: number,
				state: input.state,
			});
		case "edit":
			return github.pulls.update({
				owner,
				repo,
				pull_number: number,
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.body !== undefined ? { body: input.body } : {}),
			});
		case "reviewers":
			if (input.remove.length)
				await github.pulls.removeRequestedReviewers({
					owner,
					repo,
					pull_number: number,
					reviewers: [...input.remove],
				});
			if (input.add.length)
				await github.pulls.requestReviewers({
					owner,
					repo,
					pull_number: number,
					reviewers: [...input.add],
				});
			return;
		case "labels":
			return github.issues.setLabels({
				owner,
				repo,
				issue_number: number,
				labels: [...input.labels],
			});
		case "assignees":
			return changeAssignees(github, { owner, repo, number }, input);
		case "rerun":
			return "jobId" in input.target
				? rerunJob(github, { owner, repo }, input.target.jobId)
				: github.actions.reRunWorkflowFailedJobs({
						owner,
						repo,
						run_id: input.target.failedInRunId,
					});
	}
}

/**
 * Re-runs one Actions job. When GitHub refuses with its bare "Unknown error"
 * (it says that for a job it will not start), the job's own annotation names
 * the reason, such as a failed payment or a spending limit: it is read and
 * added to the refusal.
 */
async function rerunJob(
	github: Github,
	{ owner, repo }: { owner: string; repo: string },
	jobId: number,
) {
	try {
		return await github.actions.reRunJobForWorkflowRun({
			owner,
			repo,
			job_id: jobId,
		});
	} catch (error) {
		const [reason] = await jobAnnotations(github, { owner, repo }, jobId);
		if (!reason || typeof error !== "object" || error === null) throw error;
		const status = Number((error as { status?: unknown }).status);
		throw Object.assign(new Error(`${reason}`), { status });
	}
}

/** What GitHub says about an Actions job in its annotations (never throws; empty when none). */
async function jobAnnotations(
	github: Github,
	{ owner, repo }: { owner: string; repo: string },
	jobId: number,
): Promise<string[]> {
	try {
		const { data } = await github.checks.listAnnotations({
			owner,
			repo,
			check_run_id: jobId,
			per_page: 5,
		});
		return data
			.map((annotation) => annotation.message?.trim())
			.filter((text): text is string => Boolean(text))
			.map((text) => text.slice(0, 400));
	} catch {
		return [];
	}
}

/** A repository-scoped comment id must also belong to the selected issue or PR. */
export async function requireCommentOnItem(
	github: Github,
	target: { owner: string; repo: string; number: number },
	kind: "comment" | "inline",
	commentId: number,
) {
	const { owner, repo, number } = target;
	const parent =
		kind === "comment"
			? (await github.issues.getComment({ owner, repo, comment_id: commentId }))
					.data.issue_url
			: (
					await github.pulls.getReviewComment({
						owner,
						repo,
						comment_id: commentId,
					})
				).data.pull_request_url;
	const expected = `https://api.github.com/repos/${owner}/${repo}/${kind === "comment" ? "issues" : "pulls"}/${number}`;
	if (parent.toLowerCase() !== expected.toLowerCase())
		throw new Response("Comment not found on this item.", { status: 404 });
}

/** Adds and removes assignees on an issue or pull request. */
export async function changeAssignees(
	github: Github,
	{ owner, repo, number }: { owner: string; repo: string; number: number },
	input: {
		readonly add: readonly string[];
		readonly remove: readonly string[];
	},
) {
	if (input.remove.length)
		await github.issues.removeAssignees({
			owner,
			repo,
			issue_number: number,
			assignees: [...input.remove],
		});
	if (input.add.length)
		await github.issues.addAssignees({
			owner,
			repo,
			issue_number: number,
			assignees: [...input.add],
		});
}

/** The labels and assignable people of a repository, for the pickers. */
export async function repositoryChoices(
	token: string,
	fullName: string,
): Promise<RepositoryChoices> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const [labels, people] = await Promise.all([
		github.paginate(github.issues.listLabelsForRepo, {
			owner,
			repo,
			per_page: 100,
		}),
		github.paginate(github.issues.listAssignees, {
			owner,
			repo,
			per_page: 100,
		}),
	]);
	return {
		labels: labels.map((label) => ({
			name: label.name,
			color: label.color,
			description: label.description ?? null,
		})),
		people: people.map(pullRequestPerson),
	};
}

/** The full GitHub Actions job log, read only when the user opens it. */
export async function actionsJobLog(
	token: string,
	fullName: string,
	jobId: number,
): Promise<{ readonly log: string }> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	let response: Awaited<
		ReturnType<Github["actions"]["downloadJobLogsForWorkflowRun"]>
	>;
	try {
		response = await githubWrite("Actions: read", () =>
			github.actions.downloadJobLogsForWorkflowRun({
				owner,
				repo,
				job_id: jobId,
			}),
		);
	} catch (error) {
		// A job that never started has no log. GitHub's annotations say why
		// (a failed payment, a spending limit): that is what the log shows.
		const said = await jobAnnotations(github, { owner, repo }, jobId);
		if (!said.length) throw error;
		return {
			log: `GitHub has no log for this job; it did not run.\n\n${said.join("\n\n")}\n`,
		};
	}
	const data: unknown = response.data;
	if (typeof data === "string") return { log: data };
	if (data instanceof ArrayBuffer || data instanceof Uint8Array)
		return { log: new TextDecoder().decode(data) };
	throw new Error("GitHub returned an unreadable job log.");
}

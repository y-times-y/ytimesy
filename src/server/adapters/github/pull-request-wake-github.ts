import { Octokit } from "@octokit/rest";
import { logTail } from "#/domain/github-write";
import {
	type FailingCheck,
	mentionInstruction,
	type PullRequestFacts,
	type WakeComment,
} from "#/domain/pull-request-wake";
import { githubInstallationAccessToken } from "./installation-token";

const FAILED = new Set([
	"failure",
	"timed_out",
	"action_required",
	"startup_failure",
	"cancelled",
]);

function repositoryParts(fullName: string) {
	const [owner, repo, ...rest] = fullName.split("/");
	if (
		rest.length ||
		!owner ||
		!repo ||
		![owner, repo].every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
	)
		throw new Error("Invalid repository.");
	return { owner, repo };
}

export type PullRequestState = PullRequestFacts & {
	readonly open: boolean;
	/** The head branch lives in the base repository (never a fork). */
	readonly sameRepository: boolean;
	readonly baseRepositoryId: number;
};

/**
 * GitHub reads for a linked pull request through the App, scoped to its one
 * repository. Everything is re-read here: webhook payloads only carry IDs.
 */
export async function pullRequestWakeGitHub(link: {
	installationId: string;
	fullName: string;
	pullNumber: number;
}) {
	const { owner, repo } = repositoryParts(link.fullName);
	const token = await githubInstallationAccessToken(link.installationId, {
		repositoryNames: [repo],
		contents: "read",
		pullRequests: "write",
		checks: "read",
	});
	const github = new Octokit({ auth: token, request: { timeout: 15_000 } });
	const pull_number = link.pullNumber;
	return {
		async pull(): Promise<PullRequestState> {
			const pr = (await github.rest.pulls.get({ owner, repo, pull_number }))
				.data;
			return {
				fullName: link.fullName,
				number: pr.number,
				title: pr.title,
				url: pr.html_url,
				headRef: pr.head.ref,
				baseRef: pr.base.ref,
				headSha: pr.head.sha,
				open: pr.state === "open" && !pr.merged_at,
				sameRepository: pr.head.repo?.id === pr.base.repo.id,
				baseRepositoryId: pr.base.repo.id,
			};
		},
		/** The comment, when a person wrote it on this pull request and it still mentions the App (`@<GITHUB_APP_SLUG>`). */
		async comment(
			kind: "comment" | "review_comment",
			id: number,
		): Promise<WakeComment | null> {
			const comment =
				kind === "comment"
					? (
							await github.rest.issues.getComment({
								owner,
								repo,
								comment_id: id,
							})
						).data
					: (
							await github.rest.pulls.getReviewComment({
								owner,
								repo,
								comment_id: id,
							})
						).data;
			const onThisPull =
				"pull_request_url" in comment && comment.pull_request_url
					? comment.pull_request_url.endsWith(`/pulls/${pull_number}`)
					: "issue_url" in comment &&
						comment.issue_url.endsWith(`/issues/${pull_number}`);
			if (!onThisPull || comment.user?.type !== "User" || !comment.user.login)
				return null;
			const instruction = mentionInstruction(
				comment.body ?? "",
				process.env.GITHUB_APP_SLUG,
			);
			if (instruction === null) return null;
			return {
				author: comment.user.login,
				instruction,
				url: comment.html_url,
				...("path" in comment
					? {
							path: comment.path,
							line: comment.line ?? comment.original_line ?? null,
							diffHunk: comment.diff_hunk?.slice(-2000) ?? null,
						}
					: {}),
			};
		},
		/** Only a collaborator who can push (write, maintain or admin) may direct the agent. */
		async canWrite(login: string) {
			const permission = (
				await github.rest.repos.getCollaboratorPermissionLevel({
					owner,
					repo,
					username: login,
				})
			).data;
			const role = permission.role_name ?? "";
			return (
				["admin", "write"].includes(permission.permission) ||
				["admin", "maintain", "write"].includes(role)
			);
		},
		/** Failed check runs on this commit, newest first, with annotations and (when allowed) log tails. */
		async failingChecks(headSha: string): Promise<FailingCheck[]> {
			const runs = (
				await github.rest.checks.listForRef({
					owner,
					repo,
					ref: headSha,
					filter: "latest",
					per_page: 100,
				})
			).data.check_runs
				.filter((run) => FAILED.has(run.conclusion ?? ""))
				.slice(0, 5);
			const logs = await actionsLogReader(link.installationId, owner, repo);
			return Promise.all(
				runs.map(async (run) => {
					const annotations = run.output?.annotations_count
						? (
								await github.rest.checks
									.listAnnotations({
										owner,
										repo,
										check_run_id: run.id,
										per_page: 20,
									})
									.catch(() => ({ data: [] }))
							).data
						: [];
					return {
						name: run.name,
						conclusion: run.conclusion ?? "failure",
						url: run.html_url ?? run.details_url ?? null,
						summary:
							[run.output?.title, run.output?.summary, run.output?.text]
								.filter(Boolean)
								.join("\n")
								.slice(0, 6000) || null,
						annotations: annotations.map((annotation) => ({
							path: annotation.path,
							line: annotation.start_line,
							message: (annotation.message ?? "").slice(0, 1000),
						})),
						logTail:
							logs && run.app?.slug === "github-actions"
								? await logs(run.id)
								: null,
					};
				}),
			);
		},
		/**
		 * Closes the pull request (never merges, never deletes the branch) when
		 * its head is already contained in the base branch: the work landed
		 * some other way (a push to the default branch, a merge elsewhere), so
		 * the pull request is stale. Returns whether it closed it.
		 */
		async closeIfLanded(
			pr: Pick<PullRequestState, "baseRef" | "headSha">,
			note: string,
		): Promise<boolean> {
			const comparison = (
				await github.rest.repos.compareCommitsWithBasehead({
					owner,
					repo,
					basehead: `${pr.baseRef}...${pr.headSha}`,
				})
			).data;
			if (comparison.status !== "behind" && comparison.status !== "identical")
				return false;
			await github.rest.issues
				.createComment({ owner, repo, issue_number: pull_number, body: note })
				.catch(() => undefined);
			await github.rest.pulls.update({
				owner,
				repo,
				pull_number,
				state: "closed",
			});
			return true;
		},
		/** Best effort: a short reply saying where the chat is. */
		async reply(body: string) {
			await github.rest.issues.createComment({
				owner,
				repo,
				issue_number: pull_number,
				body,
			});
		},
	};
}

/**
 * Actions job logs need the optional Actions: read permission. Without it
 * the token request fails and the wake carries check output only.
 */
async function actionsLogReader(
	installationId: string,
	owner: string,
	repo: string,
) {
	let github: Octokit;
	try {
		github = new Octokit({
			auth: await githubInstallationAccessToken(installationId, {
				repositoryNames: [repo],
				actions: "read",
			}),
			request: { timeout: 15_000 },
		});
	} catch {
		return null;
	}
	return async (jobId: number) => {
		try {
			const response = await github.rest.actions.downloadJobLogsForWorkflowRun({
				owner,
				repo,
				job_id: jobId,
			});
			const text =
				typeof response.data === "string"
					? response.data
					: String(response.data);
			return logTail(text);
		} catch {
			return null;
		}
	};
}

export { logTail };

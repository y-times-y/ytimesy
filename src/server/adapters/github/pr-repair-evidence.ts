import { Octokit } from "@octokit/rest";
import { Effect } from "effect";
import type { PrRepairSignal } from "#/domain/pr-repair-signal";
import { publicToolDetail } from "#/domain/tool-detail";
import { readGitHubAppCredentials } from "./credentials";
import { createOctokitGitHubListing } from "./octokit-app";

/** Re-fetch authenticated current state; a signed but stale webhook cannot trigger edits. */
export async function currentPrRepairEvidence(
	signal: PrRepairSignal,
	url: string,
	installationId: string,
) {
	const prefix = `https://github.com/${signal.fullName}/pull/`;
	if (!url.startsWith(prefix) || !/^\d+$/.test(url.slice(prefix.length)))
		return null;
	const pull_number = Number(url.slice(prefix.length));
	if (signal.prNumber !== null && pull_number !== signal.prNumber) return null;
	const [owner, repo] = signal.fullName.split("/");
	const credentials = await Effect.runPromise(readGitHubAppCredentials());
	const token = await createOctokitGitHubListing().installationToken({
		credentials,
		installationId,
		repositoryNames: [repo],
		pullRequests: "read",
		...(signal.kind !== "review" ? { checks: "read" as const } : {}),
	});
	const github = new Octokit({ auth: token, request: { timeout: 15000 } });
	const pr = (await github.rest.pulls.get({ owner, repo, pull_number })).data;
	if (
		pr.state !== "open" ||
		pr.head.sha !== signal.headSha ||
		pr.base.repo.id !== signal.repositoryId
	)
		return null;
	if (signal.kind === "review") {
		const review = (
			await github.rest.pulls.getReview({
				owner,
				repo,
				pull_number,
				review_id: signal.sourceId,
			})
		).data;
		if (
			review.state.toLowerCase() !== "changes_requested" ||
			review.commit_id !== pr.head.sha
		)
			return null;
		const comments = (
			await github.rest.pulls.listCommentsForReview({
				owner,
				repo,
				pull_number,
				review_id: signal.sourceId,
				per_page: 30,
			})
		).data;
		return publicToolDetail({
			reviewId: review.id,
			state: review.state,
			body: (review.body ?? "").slice(0, 6000),
			comments: comments.map((comment) => ({
				path: comment.path,
				line: comment.line,
				body: comment.body.slice(0, 2000),
			})),
			commentsMayBeTruncated: comments.length === 30,
		});
	}
	const check =
		signal.kind === "check_run"
			? (
					await github.rest.checks.get({
						owner,
						repo,
						check_run_id: signal.sourceId,
					})
				).data
			: (
					await github.rest.checks.getSuite({
						owner,
						repo,
						check_suite_id: signal.sourceId,
					})
				).data;
	if (
		check.head_sha !== signal.headSha ||
		!["failure", "timed_out", "action_required", "startup_failure"].includes(
			check.conclusion ?? "",
		)
	)
		return null;
	const annotations =
		signal.kind === "check_run"
			? (
					await github.rest.checks.listAnnotations({
						owner,
						repo,
						check_run_id: signal.sourceId,
						per_page: 30,
					})
				).data
			: [];
	return publicToolDetail({
		kind: signal.kind,
		id: check.id,
		conclusion: check.conclusion,
		annotations: annotations.map((annotation) => ({
			path: annotation.path,
			startLine: annotation.start_line,
			endLine: annotation.end_line,
			level: annotation.annotation_level,
			message: (annotation.message ?? "").slice(0, 2000),
		})),
		annotationsMayBeTruncated: annotations.length === 30,
		...("name" in check
			? {
					name: check.name,
					output: check.output
						? {
								title: check.output.title,
								summary: check.output.summary?.slice(0, 6000),
							}
						: null,
				}
			: {}),
	});
}

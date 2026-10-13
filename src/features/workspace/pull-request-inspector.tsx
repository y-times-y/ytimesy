import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CircleCheck,
	CircleDashed,
	CircleX,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	MessageSquare,
} from "lucide-react";
import { useState } from "react";
import type {
	PullRequestCheck,
	PullRequestDetail,
} from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";
import { AgentMarkdown } from "../sessions/agent-markdown";
import { FileChangeCounts } from "../sessions/file-change-counts";
import { DiffInspector } from "./diff-inspector";
import "./pull-request-inspector.css";

export type PullRequestSource = {
	readonly installationId: number;
	readonly repositoryId: number;
	readonly number: number;
};

const stateLabel: Record<PullRequestDetail["state"], string> = {
	draft: "Draft",
	open: "Open",
	merged: "Merged",
	closed: "Closed",
};

function CheckIcon({ state }: { state: PullRequestCheck["state"] }) {
	if (state === "passed") return <CircleCheck size={14} data-tone="ok" />;
	if (state === "failed") return <CircleX size={14} data-tone="bad" />;
	return <CircleDashed size={14} data-tone="wait" />;
}

/** Review a chat's pull request without leaving ytimesy. */
export function PullRequestInspector({
	source,
}: {
	source: PullRequestSource;
}) {
	const cache = useQueryClient();
	const key = ["pull-request", source.repositoryId, source.number] as const;
	const query = new URLSearchParams({
		installationId: String(source.installationId),
		repositoryId: String(source.repositoryId),
		number: String(source.number),
	});
	const detail = useQuery({
		queryKey: key,
		queryFn: () =>
			requestJson<PullRequestDetail>(`/api/github/pull-request?${query}`),
		refetchInterval: 30_000,
	});
	const [confirmMerge, setConfirmMerge] = useState(false);
	const act = useMutation({
		mutationFn: (
			input: { action: "ready" } | { action: "merge"; headSha: string },
		) =>
			requestJson<PullRequestDetail>("/api/github/pull-request", {
				...source,
				...input,
			}),
		onSuccess: (next) => {
			cache.setQueryData(key, next);
			void cache.invalidateQueries({ queryKey: ["pull-requests"] });
			setConfirmMerge(false);
		},
	});
	if (detail.isPending)
		return <p className="pr-review-status">Loading pull request…</p>;
	if (detail.error || !detail.data)
		return (
			<p className="pr-review-status" role="alert">
				{detail.error?.message ?? "Pull request is unavailable."}
			</p>
		);
	const pr = detail.data;
	const failed = pr.checks.filter((check) => check.state === "failed").length;
	const pending = pr.checks.filter((check) => check.state === "pending").length;
	const passed = pr.checks.filter((check) => check.state === "passed").length;
	const canMerge =
		pr.state === "open" &&
		pr.mergeable === true &&
		failed === 0 &&
		pending === 0;
	return (
		<section className="pr-review" aria-label="Pull request review">
			<header className="pr-review-head">
				<div className="pr-review-title">
					<span className="pr-review-state" data-state={pr.state}>
						{pr.state === "merged" ? (
							<GitMerge size={13} />
						) : (
							<GitPullRequest size={13} />
						)}
						{stateLabel[pr.state]}
					</span>
					<h2>
						{pr.title} <span>#{pr.number}</span>
					</h2>
				</div>
				<p className="pr-review-meta">
					<code>{pr.head}</code> into <code>{pr.base}</code>
					{pr.author ? ` · opened by ${pr.author}` : ""}
				</p>
				<div className="pr-review-actions">
					<a
						className="settings-secondary"
						href={pr.url}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink size={13} /> GitHub
					</a>
					{pr.state === "draft" ? (
						<button
							type="button"
							className="settings-secondary"
							disabled={act.isPending}
							onClick={() => act.mutate({ action: "ready" })}
						>
							Ready for review
						</button>
					) : null}
					{pr.state === "open" ? (
						confirmMerge ? (
							<>
								<button
									type="button"
									className="settings-secondary"
									onClick={() => setConfirmMerge(false)}
								>
									Cancel
								</button>
								<button
									type="button"
									className="settings-primary"
									disabled={act.isPending}
									onClick={() =>
										act.mutate({ action: "merge", headSha: pr.headSha })
									}
								>
									{act.isPending
										? "Merging…"
										: `Squash and merge into ${pr.base}`}
								</button>
							</>
						) : (
							<button
								type="button"
								className="settings-primary"
								disabled={!canMerge}
								title={
									canMerge
										? undefined
										: pr.mergeable === false
											? "This branch has conflicts with the base branch."
											: failed
												? "Checks are failing."
												: "Waiting for checks or GitHub's mergeability check."
								}
								onClick={() => setConfirmMerge(true)}
							>
								Merge
							</button>
						)
					) : null}
				</div>
				{act.error ? (
					<p className="pr-review-status" role="alert">
						{act.error.message}
					</p>
				) : null}
			</header>
			<div className="pr-review-summary">
				<FileChangeCounts additions={pr.additions} deletions={pr.deletions} />
				<span>
					{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
				</span>
				<span>
					<MessageSquare size={12} /> {pr.comments}
				</span>
				{pr.checks.length ? (
					<span data-tone={failed ? "bad" : pending ? "wait" : "ok"}>
						{failed
							? `${failed} failing`
							: pending
								? `${pending} pending`
								: `${passed} checks passed`}
					</span>
				) : (
					<span>No checks</span>
				)}
			</div>
			{pr.checks.length ? (
				<details className="pr-review-section" open={failed > 0}>
					<summary>Checks</summary>
					<ul className="pr-review-checks">
						{pr.checks.map((check) => (
							<li key={`${check.name}:${check.url ?? ""}`}>
								<CheckIcon state={check.state} />
								{check.url ? (
									<a href={check.url} target="_blank" rel="noreferrer">
										{check.name}
									</a>
								) : (
									<span>{check.name}</span>
								)}
							</li>
						))}
					</ul>
				</details>
			) : null}
			{pr.reviews.length ? (
				<details className="pr-review-section">
					<summary>Reviews</summary>
					<ul className="pr-review-checks">
						{pr.reviews.map((review) => (
							<li key={`${review.author}:${review.submittedAt ?? ""}`}>
								<span>{review.author}</span>
								<span className="pr-review-muted">
									{review.state.toLowerCase().replaceAll("_", " ")}
								</span>
							</li>
						))}
					</ul>
				</details>
			) : null}
			{pr.body.trim() ? (
				<details className="pr-review-section pr-review-body">
					<summary>Description</summary>
					<AgentMarkdown text={pr.body} />
				</details>
			) : null}
			{pr.files.length ? (
				<DiffInspector changes={pr.files} />
			) : (
				<p className="pr-review-status">
					No file changes in this pull request.
				</p>
			)}
		</section>
	);
}

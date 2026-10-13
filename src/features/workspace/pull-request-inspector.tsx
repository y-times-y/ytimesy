import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Bot,
	ChevronDown,
	CircleCheck,
	CircleDashed,
	CircleX,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	MessageSquare,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import type {
	ListedRepositoryPullRequest,
	PullRequestCheck,
	PullRequestComment,
	PullRequestDetail,
	PullRequestPerson,
} from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";
import { AgentMarkdown } from "../sessions/agent-markdown";
import { FileChangeCounts } from "../sessions/file-change-counts";
import { DiffInspector } from "./diff-inspector";
import "./pull-request-inspector.css";

export type PullRequestRepository = {
	readonly installationId: number;
	readonly repositoryId: number;
	/** The chat's own pull request, opened first when there is one. */
	readonly number?: number;
};

export type PullRequestSource = PullRequestRepository & {
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

function Avatar({
	person,
	size = 20,
}: {
	person: PullRequestPerson;
	size?: number;
}) {
	return person.avatarUrl ? (
		<img
			className="pr-avatar"
			src={`${person.avatarUrl}${person.avatarUrl.includes("?") ? "&" : "?"}s=${size * 2}`}
			alt=""
			width={size}
			height={size}
		/>
	) : (
		<span className="pr-avatar" style={{ width: size, height: size }} />
	);
}

const kindLabel: Record<PullRequestComment["kind"], string> = {
	comment: "commented",
	review: "reviewed",
	inline: "commented on",
};

function timeAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 60) return `${days}d ago`;
	return new Date(iso).toLocaleDateString();
}

function Conversation({ entries }: { entries: readonly PullRequestComment[] }) {
	return (
		<section className="pr-conversation" aria-label="Conversation">
			<h3>
				Conversation <span>{entries.length}</span>
			</h3>
			<ol>
				{entries.map((entry) => (
					<li key={entry.id} className="pr-comment">
						<Avatar person={entry.author} size={24} />
						<div className="pr-comment-main">
							<p className="pr-comment-head">
								<strong>{entry.author.login.replace(/\[bot\]$/, "")}</strong>
								{entry.author.bot ? (
									<span className="pr-bot">
										<Bot size={11} /> bot
									</span>
								) : null}
								<span className="pr-review-muted">
									{kindLabel[entry.kind]}
									{entry.kind === "inline" && entry.path ? (
										<>
											{" "}
											<code>
												{entry.path}
												{entry.line ? `:${entry.line}` : ""}
											</code>
										</>
									) : null}
									{entry.reviewState && entry.reviewState !== "COMMENTED"
										? ` · ${entry.reviewState.toLowerCase().replaceAll("_", " ")}`
										: ""}
									{" · "}
									{entry.url ? (
										<a href={entry.url} target="_blank" rel="noreferrer">
											{timeAgo(entry.createdAt)}
										</a>
									) : (
										timeAgo(entry.createdAt)
									)}
								</span>
							</p>
							{entry.diffHunk ? (
								<pre className="pr-comment-hunk">
									{entry.diffHunk.split("\n").map((line, index) => (
										<span
											// biome-ignore lint/suspicious/noArrayIndexKey: hunk lines have no identity
											key={index}
											data-sign={
												line.startsWith("+")
													? "add"
													: line.startsWith("-")
														? "del"
														: line.startsWith("@@")
															? "hunk"
															: undefined
											}
										>
											{line}
											{"\n"}
										</span>
									))}
								</pre>
							) : null}
							<div className="pr-comment-body">
								<AgentMarkdown text={entry.body} />
							</div>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

/** Review any open pull request of the project's repository without leaving ytimesy. */
export function PullRequestInspector({
	repository,
}: {
	repository: PullRequestRepository;
}) {
	const list = useQuery({
		queryKey: ["pull-requests", "open", repository.repositoryId],
		queryFn: () =>
			requestJson<{ pullRequests: ListedRepositoryPullRequest[] }>(
				`/api/github/pull-request?${new URLSearchParams({
					installationId: String(repository.installationId),
					repositoryId: String(repository.repositoryId),
				})}`,
			),
	});
	const [picked, setPicked] = useState<number | undefined>();
	const open = list.data?.pullRequests ?? [];
	const number = picked ?? repository.number ?? open[0]?.number;
	if (number === undefined)
		return (
			<p className="pr-review-status" role={list.error ? "alert" : undefined}>
				{list.isPending
					? "Loading pull requests…"
					: (list.error?.message ??
						"No open pull requests in this repository.")}
			</p>
		);
	const picker =
		open.length > 1 || (open.length === 1 && open[0]?.number !== number) ? (
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button type="button" className="pr-picker">
						{open.length} open <ChevronDown size={12} />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						className="inspector-view-menu pr-picker-menu"
						sideOffset={6}
						align="end"
					>
						{open.map((pr) => (
							<DropdownMenu.Item
								key={pr.number}
								data-active={pr.number === number}
								onSelect={() => setPicked(pr.number)}
							>
								<span className="pr-review-muted">#{pr.number}</span>
								<span className="pr-picker-title">{pr.title}</span>
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		) : null;
	return (
		<PullRequestReview
			key={number}
			source={{ ...repository, number }}
			picker={picker}
		/>
	);
}

function PullRequestReview({
	source,
	picker,
}: {
	source: PullRequestSource;
	picker: React.ReactNode;
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
					{picker}
				</div>
				<div className="pr-review-meta">
					{pr.participants.length ? (
						<span
							className="pr-avatars"
							title={pr.participants.map((person) => person.login).join(", ")}
						>
							{pr.participants.slice(0, 6).map((person) => (
								<Avatar key={person.login} person={person} size={18} />
							))}
						</span>
					) : null}
					<span>
						{pr.author ? <strong>{pr.author}</strong> : null} wants to merge{" "}
						<code>{pr.head}</code> into <code>{pr.base}</code>
					</span>
				</div>
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
			{pr.conversation.length ? (
				<Conversation entries={pr.conversation} />
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

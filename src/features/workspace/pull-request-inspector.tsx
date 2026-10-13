import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	CircleCheck,
	CircleDashed,
	CircleX,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	GitPullRequestDraft,
	TriangleAlert,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type {
	ListedRepositoryPullRequest,
	PullRequestCheck,
	PullRequestComment,
	PullRequestDetail,
	PullRequestPerson,
} from "#/domain/pull-request-review";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { requestJson } from "../projects/api";
import { AgentMarkdown } from "../sessions/agent-markdown";
import {
	HighlightedTokens,
	useHighlightedLines,
} from "../sessions/highlighted-code";
import { DiffInspector } from "./diff-inspector";
import "./pull-request-inspector.css";

export type PullRequestRepository = {
	readonly installationId: number;
	readonly repositoryId: number;
	/** The chat's own pull request, opened first when there is one. */
	readonly number?: number;
};

type PullRequestSource = PullRequestRepository & {
	readonly number: number;
};

type Tab = "conversation" | "files" | "checks";

const stateLabel: Record<PullRequestDetail["state"], string> = {
	draft: "Draft",
	open: "Open",
	merged: "Merged",
	closed: "Closed",
};

function StateIcon({ state }: { state: PullRequestDetail["state"] }) {
	if (state === "merged") return <GitMerge size={12} />;
	if (state === "draft") return <GitPullRequestDraft size={12} />;
	return <GitPullRequest size={12} />;
}

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

function displayName(person: PullRequestPerson) {
	return person.login.replace(/\[bot\]$/, "");
}

function timeAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.round(months / 12)}y ago`;
}

function Time({ iso, href }: { iso: string; href?: string | null }) {
	const label = timeAgo(iso);
	const title = new Date(iso).toLocaleString();
	return href ? (
		<a href={href} target="_blank" rel="noreferrer" title={title}>
			{label}
		</a>
	) : (
		<time dateTime={iso} title={title}>
			{label}
		</time>
	);
}

/** Long comments start folded so one bot summary doesn't bury the thread. */
function Folded({ children }: { children: ReactNode }) {
	const body = useRef<HTMLDivElement>(null);
	const [tall, setTall] = useState(false);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (body.current) setTall(body.current.scrollHeight > 340);
	}, []);
	return (
		<div className="pr-fold" data-folded={tall && !open}>
			<div ref={body} className="pr-comment-body">
				{children}
			</div>
			{tall ? (
				<button
					type="button"
					className="pr-fold-toggle"
					onClick={() => setOpen((value) => !value)}
				>
					{open ? "Show less" : "Show more"}
				</button>
			) : null}
		</div>
	);
}

function Hunk({ entry }: { entry: PullRequestComment }) {
	const lines = (entry.diffHunk ?? "")
		.split("\n")
		.filter((line) => !line.startsWith("@@"))
		.slice(-6);
	const code = lines.map((line) => line.slice(1));
	const highlighted = useHighlightedLines(
		code.join("\n"),
		sourceLanguageFromPath(entry.path ?? ""),
	);
	return (
		<figure className="pr-hunk">
			<figcaption>
				<span>{entry.path}</span>
				{entry.line ? <span>Line {entry.line}</span> : null}
			</figcaption>
			<pre>
				{lines.map((line, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: hunk lines have no identity
						key={index}
						data-sign={
							line.startsWith("+")
								? "add"
								: line.startsWith("-")
									? "del"
									: undefined
						}
						data-target={index === lines.length - 1 || undefined}
					>
						<i>{line[0] === "+" || line[0] === "-" ? line[0] : " "}</i>
						<HighlightedTokens
							text={code[index] ?? ""}
							tokens={highlighted?.[index]}
						/>
						{"\n"}
					</span>
				))}
			</pre>
		</figure>
	);
}

const reviewVerb: Record<string, string> = {
	APPROVED: "approved these changes",
	CHANGES_REQUESTED: "requested changes",
	DISMISSED: "had a review dismissed",
};

function Comment({
	author,
	verb,
	tone,
	createdAt,
	url,
	children,
}: {
	author: PullRequestPerson;
	verb: string;
	tone?: "ok" | "bad";
	createdAt: string;
	url?: string | null;
	children?: ReactNode;
}) {
	return (
		<li className="pr-comment">
			<Avatar person={author} size={24} />
			<div className="pr-comment-main">
				<p className="pr-comment-head">
					<strong>{displayName(author)}</strong>
					{author.bot ? <span className="pr-bot">Bot</span> : null}
					<span data-tone={tone}>{verb}</span>
					<span aria-hidden>·</span>
					<Time iso={createdAt} href={url} />
				</p>
				{children}
			</div>
		</li>
	);
}

function Conversation({
	pr,
	people,
	mergeBox,
}: {
	pr: PullRequestDetail;
	people: Map<string, PullRequestPerson>;
	mergeBox: ReactNode;
}) {
	const author = people.get(pr.author) ?? {
		login: pr.author,
		avatarUrl: pr.authorAvatarUrl,
		bot: false,
	};
	// Approvals and change requests often have no text; they still belong in the thread.
	const verdicts = pr.reviews
		.filter((review) => reviewVerb[review.state] && review.submittedAt)
		.map((review) => ({
			id: `verdict:${review.author}:${review.submittedAt}`,
			author: people.get(review.author) ?? {
				login: review.author,
				avatarUrl: null,
				bot: review.author.endsWith("[bot]"),
			},
			state: review.state,
			createdAt: review.submittedAt ?? "",
		}));
	const timeline = [
		...pr.conversation.map((entry) => ({
			at: entry.createdAt,
			node: (
				<Comment
					key={entry.id}
					author={entry.author}
					verb={
						entry.kind === "inline"
							? "commented on code"
							: entry.kind === "review"
								? "reviewed"
								: "commented"
					}
					createdAt={entry.createdAt}
					url={entry.url}
				>
					{entry.kind === "inline" ? <Hunk entry={entry} /> : null}
					<Folded>
						<AgentMarkdown text={entry.body} fileMentions={false} />
					</Folded>
				</Comment>
			),
		})),
		...verdicts.map((verdict) => ({
			at: verdict.createdAt,
			node: (
				<Comment
					key={verdict.id}
					author={verdict.author}
					verb={reviewVerb[verdict.state] ?? "reviewed"}
					tone={verdict.state === "APPROVED" ? "ok" : "bad"}
					createdAt={verdict.createdAt}
				/>
			),
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
	return (
		<div className="pr-thread">
			<ol>
				<Comment
					author={author}
					verb="opened this pull request"
					createdAt={pr.createdAt}
				>
					{pr.body.trim() ? (
						<Folded>
							<AgentMarkdown text={pr.body} fileMentions={false} />
						</Folded>
					) : (
						<p className="pr-muted">No description provided.</p>
					)}
				</Comment>
				{timeline.map((item) => item.node)}
			</ol>
			{mergeBox}
		</div>
	);
}

function Checks({ checks }: { checks: readonly PullRequestCheck[] }) {
	if (!checks.length)
		return <p className="pr-empty">No checks ran on this pull request.</p>;
	return (
		<ul className="pr-checks">
			{checks.map((check) => (
				<li key={`${check.name}:${check.url ?? ""}`}>
					<CheckIcon state={check.state} />
					<span className="pr-check-name">{check.name}</span>
					<span className="pr-muted">
						{check.state === "passed"
							? "Passed"
							: check.state === "failed"
								? "Failed"
								: "Running"}
					</span>
					{check.url ? (
						<a
							className="pr-ghost"
							href={check.url}
							target="_blank"
							rel="noreferrer"
							aria-label={`Open ${check.name}`}
						>
							<ExternalLink size={13} />
						</a>
					) : null}
				</li>
			))}
		</ul>
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
			<p className="pr-empty" role={list.error ? "alert" : undefined}>
				{list.isPending
					? "Loading pull requests…"
					: (list.error?.message ??
						"No open pull requests in this repository.")}
			</p>
		);
	const picker = open.length ? (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button type="button" className="pr-ghost">
					{open.length} open
					<ChevronDown size={12} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="pr-picker-menu"
					sideOffset={6}
					align="end"
				>
					{open.map((pr) => (
						<DropdownMenu.Item
							key={pr.number}
							className="pr-picker-item"
							onSelect={() => setPicked(pr.number)}
						>
							<span className="pr-picker-text">
								<span className="pr-picker-title">{pr.title}</span>
								<span className="pr-picker-meta">
									#{pr.number} · {pr.author}
									{pr.draft ? " · Draft" : ""}
								</span>
							</span>
							{pr.number === number ? <Check size={13} /> : null}
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
	picker: ReactNode;
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
	const [tab, setTab] = useState<Tab>("conversation");
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
		return <p className="pr-empty">Loading pull request…</p>;
	if (detail.error || !detail.data)
		return (
			<p className="pr-empty" role="alert">
				{detail.error?.message ?? "Pull request is unavailable."}
			</p>
		);
	const pr = detail.data;
	const people = new Map(
		pr.participants.map((person) => [person.login, person]),
	);
	const failed = pr.checks.filter((check) => check.state === "failed").length;
	const pending = pr.checks.filter((check) => check.state === "pending").length;
	const canMerge =
		pr.state === "open" &&
		pr.mergeable === true &&
		failed === 0 &&
		pending === 0;
	const checksState: PullRequestCheck["state"] = failed
		? "failed"
		: pending
			? "pending"
			: "passed";
	const checksSummary = !pr.checks.length
		? "No checks"
		: failed
			? `${failed} of ${pr.checks.length} checks failing`
			: pending
				? `${pending} of ${pr.checks.length} checks running`
				: pr.checks.length === 1
					? "1 check passed"
					: `All ${pr.checks.length} checks passed`;
	const mergeBox =
		pr.state === "open" || pr.state === "draft" ? (
			<section className="pr-merge" aria-label="Merge">
				<div className="pr-merge-row">
					{pr.checks.length ? (
						<CheckIcon state={checksState} />
					) : (
						<CircleDashed size={14} data-tone="none" />
					)}
					<span>{checksSummary}</span>
					{pr.checks.length ? (
						<button
							type="button"
							className="pr-link"
							onClick={() => setTab("checks")}
						>
							Details
						</button>
					) : null}
				</div>
				<div className="pr-merge-row">
					{pr.mergeable === false ? (
						<TriangleAlert size={14} data-tone="bad" />
					) : pr.mergeable ? (
						<CircleCheck size={14} data-tone="ok" />
					) : (
						<CircleDashed size={14} data-tone="wait" />
					)}
					<span>
						{pr.mergeable === false
							? `Conflicts with ${pr.base} must be resolved`
							: pr.mergeable
								? `No conflicts with ${pr.base}`
								: "Checking for conflicts…"}
					</span>
				</div>
				<div className="pr-merge-actions">
					{pr.state === "draft" ? (
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={act.isPending}
							onClick={() => act.mutate({ action: "ready" })}
						>
							Ready for review
						</button>
					) : confirmMerge ? (
						<>
							<button
								type="button"
								className="pr-button"
								onClick={() => setConfirmMerge(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="pr-button"
								data-variant="primary"
								disabled={act.isPending}
								onClick={() =>
									act.mutate({ action: "merge", headSha: pr.headSha })
								}
							>
								{act.isPending ? "Merging…" : `Squash into ${pr.base}`}
							</button>
						</>
					) : (
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={!canMerge}
							onClick={() => setConfirmMerge(true)}
						>
							<GitMerge size={13} />
							Squash and merge
						</button>
					)}
				</div>
				{act.error ? (
					<p className="pr-merge-error" role="alert">
						{act.error.message}
					</p>
				) : null}
			</section>
		) : (
			<section className="pr-merge" aria-label="Merge">
				<div className="pr-merge-row">
					<StateIcon state={pr.state} />
					<span>
						{pr.state === "merged"
							? `Merged into ${pr.base}`
							: "This pull request was closed"}
					</span>
				</div>
			</section>
		);
	const tabs: { id: Tab; label: string; count?: number }[] = [
		{
			id: "conversation",
			label: "Conversation",
			count: pr.conversation.length,
		},
		{ id: "files", label: "Files", count: pr.changedFiles },
		{ id: "checks", label: "Checks", count: pr.checks.length || undefined },
	];
	return (
		<section className="pr" aria-label="Pull request review">
			<header className="pr-head">
				<div className="pr-head-bar">
					<span className="pr-state" data-state={pr.state}>
						<StateIcon state={pr.state} />
						{stateLabel[pr.state]}
					</span>
					<span className="pr-muted">#{pr.number}</span>
					<span className="pr-head-spacer" />
					{picker}
					<a
						className="pr-ghost"
						href={pr.url}
						target="_blank"
						rel="noreferrer"
						aria-label="Open on GitHub"
						title="Open on GitHub"
					>
						<ExternalLink size={13} />
					</a>
				</div>
				<h2 className="pr-title">{pr.title}</h2>
				<div className="pr-byline">
					{pr.participants.length ? (
						<span
							className="pr-avatars"
							title={pr.participants.map(displayName).join(", ")}
						>
							{pr.participants.slice(0, 5).map((person) => (
								<Avatar key={person.login} person={person} size={18} />
							))}
						</span>
					) : null}
					<span>
						<strong>{pr.author}</strong> wants to merge into{" "}
						<code className="pr-branch">{pr.base}</code> from{" "}
						<code className="pr-branch">{pr.head}</code>
					</span>
				</div>
			</header>
			<div className="pr-tabs" role="tablist">
				{tabs.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						aria-selected={tab === item.id}
						onClick={() => setTab(item.id)}
					>
						{item.id === "checks" && pr.checks.length ? (
							<CheckIcon state={checksState} />
						) : null}
						{item.label}
						{item.count !== undefined ? <span>{item.count}</span> : null}
					</button>
				))}
				<span className="pr-tabs-stat">
					<span data-tone="ok">+{pr.additions}</span>
					<span data-tone="bad">−{pr.deletions}</span>
				</span>
			</div>
			<div className="pr-pane" role="tabpanel" data-tab={tab}>
				{tab === "conversation" ? (
					<Conversation pr={pr} people={people} mergeBox={mergeBox} />
				) : tab === "files" ? (
					pr.files.length ? (
						<DiffInspector changes={pr.files} />
					) : (
						<p className="pr-empty">No file changes in this pull request.</p>
					)
				) : (
					<Checks checks={pr.checks} />
				)}
			</div>
		</section>
	);
}

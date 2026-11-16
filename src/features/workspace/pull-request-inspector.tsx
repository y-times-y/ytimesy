import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	ArrowLeft,
	Check,
	ChevronDown,
	CircleCheck,
	CircleDashed,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	Pencil,
	TriangleAlert,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import type {
	PullRequestWriteAction,
	ReviewLineComment,
} from "#/domain/github-write";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	githubPullFullName,
	type ListedRepositoryPullRequest,
	listedPullRequestAuthor,
	type PullRequestCheck,
	type PullRequestDetail,
	pullRequestReviewStart,
	startPullRequestReviewThread,
} from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";
import { startPullRequestReviewChat } from "../pull-requests/pull-request-review.fn";
import { DiffInspector } from "./diff-inspector";
import {
	Avatar,
	displayName,
	GithubScrollArea,
	useGithubAction,
} from "./github-ui";
import {
	CheckIcon,
	Checks,
	Conversation,
	PullRequestFields,
	ReviewSubmit,
	usePullRequestLineComments,
} from "./pull-request-collaboration";
import {
	type PullRequestSource,
	type PullRequestSummary,
	pickedPullRequestSummary,
	pullRequestDetailKey,
	pullRequestDetailQuery,
} from "./pull-request-detail-query";
import { PullRequestList } from "./pull-request-list";
import type { PullRequestChat } from "./pull-request-marks";
import "./pull-request-inspector.css";

export type PullRequestRepository = {
	readonly installationId: number;
	readonly repositoryId: number;
	/** The chat's own pull request, opened first when there is one. */
	readonly number?: number;
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
	if (state === "closed") return <GitPullRequestClosed size={12} />;
	return <GitPullRequest size={12} />;
}

/** One open pull request in the picker: title, author, and avatar. */
export function PullRequestOption({ pr }: { pr: ListedRepositoryPullRequest }) {
	const author = listedPullRequestAuthor(pr);
	return (
		<>
			<Avatar person={author} size={20} className="pr-picker-avatar" />
			<span className="pr-picker-text">
				<span className="pr-picker-title">{pr.title}</span>
				<span className="pr-picker-meta">
					#{pr.number} · <span className="pr-picker-author">{author.name}</span>
					{pr.draft ? " · Draft" : ""}
				</span>
			</span>
		</>
	);
}

/**
 * A picker row: opening the pull request and reviewing it are sibling menu
 * items, so arrow keys reach both and choosing one never triggers the other.
 */
export function PullRequestPickerRow({
	pr,
	selected,
	reviewing,
	reviewDisabled,
	onOpen,
	onReview,
}: {
	pr: ListedRepositoryPullRequest;
	selected: boolean;
	/** This row's review chat is being created. */
	reviewing: boolean;
	reviewDisabled: boolean;
	onOpen: () => void;
	/** Omitted when no project is selected to review in. */
	onReview?: () => void;
}) {
	return (
		<div className="pr-picker-row" data-selected={selected || undefined}>
			<DropdownMenu.Item className="pr-picker-item" onSelect={onOpen}>
				<PullRequestOption pr={pr} />
				{selected ? <Check size={14} /> : null}
			</DropdownMenu.Item>
			{onReview ? (
				<DropdownMenu.Item
					asChild
					disabled={reviewDisabled}
					onSelect={(event) => {
						// The menu stays open to show the pending row until the chat opens.
						event.preventDefault();
						onReview();
					}}
				>
					<button
						type="button"
						className="pr-button pr-picker-review"
						data-pending={reviewing || undefined}
						aria-label={`Review #${pr.number} with ytimesy`}
					>
						{reviewing ? "Starting…" : "Review with ytimesy"}
					</button>
				</DropdownMenu.Item>
			) : null}
		</div>
	);
}

type ReviewedPull = {
	readonly number: number;
	readonly title: string;
	readonly url: string;
};

/** Starts a new chat reviewing a pull request; retrying the same pull request reuses its request id. */
function useStartPullRequestReview(
	{
		projectId,
		harnessId,
		modelId,
		currentSessionId,
		onReviewStarted,
	}: ReviewChat,
	{
		onStarted,
		onError,
	}: { onStarted?: () => void; onError?: (error: Error) => void } = {},
) {
	const startReview = useServerFn(startPullRequestReviewChat);
	const requestIds = useRef(new Map<number, string>());
	return useMutation({
		mutationFn: (pull: ReviewedPull) => {
			if (!projectId)
				throw new Error("Select a project before starting a review.");
			const fullName = githubPullFullName(pull.url);
			if (!fullName)
				throw new Error("This pull request cannot be reviewed from here.");
			const requestId =
				requestIds.current.get(pull.number) ?? crypto.randomUUID();
			requestIds.current.set(pull.number, requestId);
			return startPullRequestReviewThread({
				currentSessionId,
				request: pullRequestReviewStart({
					projectId,
					harnessId: harnessId ?? DEFAULT_COMPOSER_HARNESS_ID,
					modelId: modelId ?? "",
					requestId,
					pull: {
						fullName,
						number: pull.number,
						title: pull.title,
						url: pull.url,
					},
				}),
				start: async (request) => {
					const chat = await startReview({ data: request });
					return { sessionId: chat.sessionId };
				},
			});
		},
		onSuccess: (sessionId) => {
			onStarted?.();
			onReviewStarted?.(sessionId);
		},
		onError,
	});
}

function ReviewWithYtimesy({
	pull,
	...chat
}: { pull: ReviewedPull } & ReviewChat) {
	const review = useStartPullRequestReview(chat);
	if (!chat.projectId) return null;
	return (
		<div className="pr-review">
			<button
				type="button"
				className="pr-button"
				disabled={review.isPending || review.isSuccess}
				onClick={() => review.mutate(pull)}
			>
				{review.isPending || review.isSuccess
					? "Starting review…"
					: "Review with ytimesy"}
			</button>
			{review.error ? (
				<p className="pr-review-error" role="alert">
					{review.error.message}
				</p>
			) : null}
		</div>
	);
}

type ReviewChat = {
	readonly projectId?: string;
	readonly harnessId?: AgentProviderId;
	readonly modelId?: string;
	/** The chat already open. A review must not continue it. */
	readonly currentSessionId?: string;
	readonly onReviewStarted?: (sessionId: string) => void;
	/** Where the back button goes; without it, to this repository's own list. */
	readonly onBack?: () => void;
	readonly pullRequestChats?: ReadonlyMap<string, PullRequestChat>;
	readonly onOpenChat?: (chatId: string) => void;
};

/** Review any open pull request of the project's repository without leaving ytimesy. */
export function PullRequestInspector({
	repository,
	summary,
	projectId,
	harnessId,
	modelId,
	currentSessionId,
	onReviewStarted,
	onBack,
	pullRequestChats,
	onOpenChat,
}: {
	repository: PullRequestRepository;
	/** What the Overview already knows about the chat's pull request (repository.number). */
	summary?: PullRequestSummary;
} & ReviewChat) {
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
	const [picked, setPicked] = useState<number | undefined>(repository.number);
	const [showList, setShowList] = useState(repository.number === undefined);
	const [menuOpen, setMenuOpen] = useState(false);
	const reviewChat = {
		projectId,
		harnessId,
		modelId,
		currentSessionId,
		onReviewStarted,
	};
	const rowReview = useStartPullRequestReview(reviewChat, {
		onStarted: () => setMenuOpen(false),
		onError: (error) => toast.error(publicFailureMessage(error)),
	});
	const reviewingNumber = rowReview.isPending
		? rowReview.variables?.number
		: undefined;
	const open = list.data?.pullRequests ?? [];
	const number = picked ?? repository.number ?? open[0]?.number;
	if (showList)
		return (
			<PullRequestList
				repositories={[{ ...repository, name: "" }]}
				chatFor={(_, head) => pullRequestChats?.get(head)}
				onOpenChat={onOpenChat}
				onOpen={(pull) => {
					setPicked(pull.number);
					setShowList(false);
				}}
			/>
		);
	if (number === undefined)
		return (
			<p className="pr-empty" role={list.error ? "alert" : undefined}>
				{list.isPending
					? "Loading pull requests…"
					: (list.error?.message ??
						"No open pull requests in this repository.")}
			</p>
		);
	const pickerMenu = open.length ? (
		<DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
			<DropdownMenu.Trigger asChild>
				<button type="button" className="pr-ghost">
					{open.length} open
					<ChevronDown size={14} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="pr-picker-menu"
					sideOffset={6}
					align="end"
				>
					{open.map((pr) => (
						<PullRequestPickerRow
							key={pr.number}
							pr={pr}
							selected={pr.number === number}
							reviewing={pr.number === reviewingNumber}
							reviewDisabled={rowReview.isPending}
							onOpen={() => setPicked(pr.number)}
							onReview={projectId ? () => rowReview.mutate(pr) : undefined}
						/>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	) : null;
	const picker = (
		<>
			<button
				type="button"
				className="pr-ghost"
				aria-label="All pull requests"
				onClick={onBack ?? (() => setShowList(true))}
			>
				<ArrowLeft size={14} />
				Pull requests
			</button>
			{pickerMenu}
		</>
	);
	const listed = open.find((pr) => pr.number === number);
	const known: PullRequestSummary = {
		...(listed ? pickedPullRequestSummary(listed) : { number }),
		...(summary?.number === number ? summary : {}),
	};
	return (
		<PullRequestReview
			key={number}
			source={{
				installationId: repository.installationId,
				repositoryId: repository.repositoryId,
				number,
			}}
			summary={known}
			picker={picker}
			projectId={projectId}
			harnessId={harnessId}
			modelId={modelId}
			currentSessionId={currentSessionId}
			onReviewStarted={onReviewStarted}
		/>
	);
}

function PullRequestReview({
	source,
	summary,
	picker,
	projectId,
	harnessId,
	modelId,
	currentSessionId,
	onReviewStarted,
}: {
	source: PullRequestSource;
	summary: PullRequestSummary;
	picker: ReactNode;
} & ReviewChat) {
	const cache = useQueryClient();
	const key = pullRequestDetailKey(source);
	// Shown at once from the cache (a prefetch or an earlier open) and read
	// again in the background when older than its fresh window.
	const detail = useQuery({
		...pullRequestDetailQuery(source),
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
	/** Every other change: comments, reviews, labels…; the answer is the updated pull request. */
	const write = async (input: PullRequestWriteAction) => {
		const next = await requestJson<PullRequestDetail>(
			"/api/github/pull-request",
			{ ...source, ...input },
		);
		cache.setQueryData(key, next);
		void cache.invalidateQueries({ queryKey: ["pull-requests"] });
		return next;
	};
	const [pendingComments, setPendingComments] = useState<ReviewLineComment[]>(
		[],
	);
	const [reviewHeadSha, setReviewHeadSha] = useState<string | undefined>();
	const pr = detail.data;
	const lineComments = usePullRequestLineComments({
		pr,
		write,
		pending: pendingComments,
		onPendingChange: (comments) => {
			if (!pendingComments.length && comments.length)
				setReviewHeadSha(pr?.headSha);
			if (!comments.length) setReviewHeadSha(undefined);
			setPendingComments(comments);
		},
	});
	const repository = {
		installationId: source.installationId,
		repositoryId: source.repositoryId,
	};
	// Until the details arrive the panel shows what the list knew; the rest
	// holds its place with skeletons.
	const view: PullRequestSummary = pr ?? summary;
	const checks = pr?.checks ?? [];
	const people = new Map(
		(pr?.participants ?? []).map((person) => [person.login, person]),
	);
	const failed = checks.filter((check) => check.state === "failed").length;
	const pending = checks.filter((check) => check.state === "pending").length;
	const canMerge =
		pr?.state === "open" &&
		pr.mergeable === true &&
		failed === 0 &&
		pending === 0;
	const checksState: PullRequestCheck["state"] = failed
		? "failed"
		: pending
			? "pending"
			: "passed";
	const checksSummary = !checks.length
		? "No checks"
		: failed
			? `${failed} of ${checks.length} checks failing`
			: pending
				? `${pending} of ${checks.length} checks running`
				: checks.length === 1
					? "1 check passed"
					: `All ${checks.length} checks passed`;
	const mergeBox = !pr ? null : pr.state === "open" || pr.state === "draft" ? (
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
						{act.isPending ? "Marking ready…" : "Ready for review"}
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
							{act.isPending ? "Merging…" : `Merge into ${pr.base}`}
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
						<GitMerge size={14} />
						Merge pull request
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
			count: pr?.conversation.length,
		},
		{ id: "files", label: "Files", count: view.changedFiles },
		{ id: "checks", label: "Checks", count: checks.length || undefined },
	];
	const state = view.state;
	const participants = pr?.participants ?? [];
	return (
		<section
			className="pr"
			aria-label="Pull request review"
			aria-busy={!pr || undefined}
		>
			<header className="pr-head">
				<div className="pr-head-bar">
					{state ? (
						<span className="pr-state" data-state={state}>
							<StateIcon state={state} />
							{stateLabel[state]}
						</span>
					) : (
						<Skeleton className="pr-skeleton-state" />
					)}
					<span className="pr-muted">#{view.number}</span>
					<span className="pr-head-spacer" />
					{view.title !== undefined && view.url ? (
						<ReviewWithYtimesy
							pull={{ number: view.number, title: view.title, url: view.url }}
							projectId={projectId}
							harnessId={harnessId}
							modelId={modelId}
							currentSessionId={currentSessionId}
							onReviewStarted={onReviewStarted}
						/>
					) : null}
					{pr ? (
						<ReviewSubmit
							pr={pr}
							pending={pendingComments}
							reviewHeadSha={reviewHeadSha}
							onSubmitted={() => setPendingComments([])}
							write={write}
						/>
					) : null}
					{picker}
					{view.url ? (
						<a
							className="pr-ghost"
							href={view.url}
							target="_blank"
							rel="noreferrer"
							aria-label="Open on GitHub"
							title="Open on GitHub"
						>
							<ExternalLink size={14} />
						</a>
					) : null}
				</div>
				{view.title !== undefined ? (
					<Title
						title={view.title}
						editable={Boolean(pr)}
						onSave={(title) => write({ action: "edit", title })}
					/>
				) : (
					<Skeleton className="pr-skeleton-title" />
				)}
				<div className="pr-byline">
					{participants.length ? (
						<span
							className="pr-avatars"
							title={participants.map(displayName).join(", ")}
						>
							{participants.slice(0, 5).map((person) => (
								<Avatar key={person.login} person={person} size={18} />
							))}
						</span>
					) : !pr && view.author ? (
						// The author comes first among the participants: hold that place.
						<span className="pr-avatars">
							<Avatar
								person={{
									login: view.author,
									avatarUrl: view.authorAvatarUrl ?? null,
									bot: false,
								}}
								size={18}
							/>
						</span>
					) : null}
					{view.author && view.base && view.head ? (
						<span>
							<strong>{view.author}</strong> wants to merge into{" "}
							<code className="pr-branch">{view.base}</code> from{" "}
							<code className="pr-branch">{view.head}</code>
						</span>
					) : (
						<Skeleton className="pr-skeleton-byline" />
					)}
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
						{item.id === "checks" && checks.length ? (
							<CheckIcon state={checksState} />
						) : null}
						{item.label}
						{item.count !== undefined ? <span>{item.count}</span> : null}
					</button>
				))}
				{view.additions !== undefined && view.deletions !== undefined ? (
					<span className="pr-tabs-stat">
						<span data-tone="ok">+{view.additions}</span>
						<span data-tone="bad">−{view.deletions}</span>
					</span>
				) : null}
			</div>
			<GithubScrollArea className="pr-pane" role="tabpanel" data-tab={tab}>
				{!pr ? (
					detail.error ? (
						<p className="pr-empty" role="alert">
							{detail.error.message}
						</p>
					) : (
						<PaneSkeleton />
					)
				) : tab === "conversation" ? (
					<Conversation
						pr={pr}
						people={people}
						mergeBox={mergeBox}
						write={write}
						fields={
							<PullRequestFields
								pr={pr}
								repository={repository}
								write={write}
							/>
						}
					/>
				) : tab === "files" ? (
					pr.files.length ? (
						<DiffInspector
							changes={pr.files}
							lineComments={lineComments}
							header={
								lineComments ? (
									<span className="gh-files-hint pr-muted">
										Click a line number to comment
									</span>
								) : null
							}
						/>
					) : (
						<p className="pr-empty">No file changes in this pull request.</p>
					)
				) : (
					<Checks checks={pr.checks} repository={repository} write={write} />
				)}
			</GithubScrollArea>
		</section>
	);
}

/** The pull request's title, renamed in place. */
function Title({
	title,
	editable,
	onSave,
}: {
	title: string;
	editable: boolean;
	onSave: (title: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const save = useGithubAction(onSave);
	const submit = async () => {
		const next = draft?.trim();
		if (!next || next === title) return setDraft(null);
		if (await save.run(next)) setDraft(null);
	};
	if (draft === null)
		return (
			<h2 className="pr-title gh-title">
				{title}
				{editable ? (
					<button
						type="button"
						className="pr-ghost gh-title-edit"
						aria-label="Edit title"
						title="Edit title"
						onClick={() => setDraft(title)}
					>
						<Pencil size={13} />
					</button>
				) : null}
			</h2>
		);
	return (
		<form
			className="gh-title-form"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<input
				aria-label="Title"
				value={draft}
				maxLength={256}
				// biome-ignore lint/a11y/noAutofocus: the user asked to edit the title
				autoFocus
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setDraft(null);
				}}
			/>
			<button
				type="button"
				className="pr-button"
				onClick={() => setDraft(null)}
			>
				Cancel
			</button>
			<button
				type="submit"
				className="pr-button"
				data-variant="primary"
				disabled={save.pending}
			>
				{save.pending ? "Saving…" : "Save"}
			</button>
			{save.error ? (
				<p className="gh-error" role="alert">
					{save.error}
				</p>
			) : null}
		</form>
	);
}

function Skeleton({ className }: { className: string }) {
	return <span className={`pr-skeleton ${className}`} aria-hidden />;
}

/** The pane's place while the details load: a description and the merge box. */
function PaneSkeleton() {
	return (
		<div className="pr-thread" aria-hidden>
			<div className="pr-skeleton-comment">
				<Skeleton className="pr-skeleton-avatar" />
				<div className="pr-skeleton-lines">
					<Skeleton className="pr-skeleton-line" />
					<Skeleton className="pr-skeleton-line" />
					<Skeleton className="pr-skeleton-line pr-skeleton-short" />
				</div>
			</div>
			<Skeleton className="pr-skeleton-merge" />
		</div>
	);
}

import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	ChevronDown,
	CircleAlert,
	GitPullRequest,
	GitPullRequestDraft,
	TriangleAlert,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useLayoutEffect,
	useState,
} from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { compactRelativeAge } from "#/domain/sidebar-chats";
import type { RepositoryPullRequest } from "#/domain/sidebar-pr";
import { threadColor } from "#/domain/thread-color";
import {
	type InProgressRow,
	type NeedsYouRow,
	runningForText,
	type ThreadPullRequestRow,
	yOverview,
} from "#/domain/y-overview";
import { listProjectAgentSessions } from "../sessions/agent-session.fn";
import { chatListRetry } from "../sessions/chat-list-retry";

/** How often the open overview reads the project's threads again. */
const LIVE_THREADS_POLL_MS = 15_000;
const CLOCK_TICK_MS = 30_000;

type GroupId = "needs-you" | "in-progress" | "pull-requests";

/**
 * The Y² chat's inspector overview: what needs the person, what is running,
 * and the open pull requests across the project's threads. It shares the
 * sidebar's chat list (same query key) and reads it again while shown.
 */
/**
 * What an empty overview says. Reading says so, and so does a failed read
 * (it is read again); only a successful, empty read says nothing is going on.
 */
export function emptyOverviewText(state: {
	readonly isPending: boolean;
	readonly isError: boolean;
}) {
	if (state.isPending) return "Reading threads…";
	if (state.isError) return "Couldn't read the threads. Trying again…";
	return "Nothing needs you. No threads running.";
}

export function YOverview({
	projectId,
	pullRequests,
	live,
	renderedAtMs,
	projectName,
	onOpenThread,
	onOpenPullRequest,
}: {
	projectId: string;
	/** The project's thread-label prefix (thread-label.ts): rows show each thread's id. */
	projectName?: string;
	/** Opens a pull request in the app (its thread, then the pull request panel); the row falls back to its thread. */
	onOpenPullRequest?: (row: ThreadPullRequestRow) => void;
	pullRequests: readonly RepositoryPullRequest[];
	/** The panel is on screen: keep the threads fresh. */
	live: boolean;
	/** When the server rendered the page: relative times hydrate from it. */
	renderedAtMs?: number;
	onOpenThread: (threadId: string) => void;
}) {
	const chats = useQuery({
		queryKey: ["agent-sessions", projectId],
		queryFn: () => listProjectAgentSessions({ data: { projectId } }),
		staleTime: 30_000,
		refetchInterval: live ? LIVE_THREADS_POLL_MS : false,
		refetchIntervalInBackground: false,
		...chatListRetry,
	});
	const nowMs = useNowMs(renderedAtMs);
	const [collapsed, setCollapsed] = useState<ReadonlySet<GroupId>>(
		() => new Set(),
	);
	const toggle = (group: GroupId) =>
		setCollapsed((current) => {
			const next = new Set(current);
			if (!next.delete(group)) next.add(group);
			return next;
		});
	const overview = yOverview({
		chats: chats.data ?? [],
		pullRequests,
		projectName,
	});
	const empty =
		!overview.needsYou.length &&
		!overview.inProgress.length &&
		!overview.pullRequests.length;

	return (
		<section className="y-overview" aria-label="Project overview">
			{empty ? (
				<p className="y-overview-empty">{emptyOverviewText(chats)}</p>
			) : null}
			<YOverviewGroup
				id="needs-you"
				label="Needs you"
				count={overview.needsYou.length}
				collapsed={collapsed.has("needs-you")}
				onToggle={toggle}
			>
				{overview.needsYou.map((row) => (
					<NeedsYouItem
						key={row.threadId}
						row={row}
						nowMs={nowMs}
						onOpen={onOpenThread}
					/>
				))}
			</YOverviewGroup>
			<YOverviewGroup
				id="in-progress"
				label="In progress"
				count={overview.inProgress.length}
				collapsed={collapsed.has("in-progress")}
				onToggle={toggle}
			>
				{overview.inProgress.map((row) => (
					<InProgressItem
						key={row.threadId}
						row={row}
						nowMs={nowMs}
						onOpen={onOpenThread}
					/>
				))}
			</YOverviewGroup>
			<YOverviewGroup
				id="pull-requests"
				label="Pull requests"
				count={overview.pullRequests.length}
				collapsed={collapsed.has("pull-requests")}
				onToggle={toggle}
			>
				{overview.pullRequests.map((row) => (
					<PullRequestItem
						key={row.reference}
						row={row}
						nowMs={nowMs}
						onOpen={onOpenThread}
						onOpenPullRequest={onOpenPullRequest}
					/>
				))}
			</YOverviewGroup>
		</section>
	);
}

/** The server's render time until hydrated, then this client's clock, ticking. */
function useNowMs(renderedAtMs: number | undefined) {
	const [nowMs, setNowMs] = useState(() => renderedAtMs ?? Date.now());
	useLayoutEffect(() => {
		setNowMs(Date.now());
		const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
		return () => window.clearInterval(timer);
	}, []);
	return nowMs;
}

function YOverviewGroup({
	id,
	label,
	count,
	collapsed,
	onToggle,
	children,
}: {
	id: GroupId;
	label: string;
	count: number;
	collapsed: boolean;
	onToggle: (id: GroupId) => void;
	children: ReactNode;
}) {
	if (!count) return null;
	const listId = `y-overview-${id}`;
	return (
		<section className="y-overview-group" data-group={id}>
			<h2 className="y-overview-group-title">
				<button
					type="button"
					className="y-overview-heading"
					aria-expanded={!collapsed}
					aria-controls={listId}
					onClick={() => onToggle(id)}
				>
					<span>{label}</span>
					<span className="y-overview-count">{count}</span>
					<ChevronDown
						className="y-overview-chevron"
						size={14}
						aria-hidden="true"
					/>
				</button>
			</h2>
			{collapsed ? null : (
				<ul id={listId} className="y-overview-rows">
					{children}
				</ul>
			)}
		</section>
	);
}

function YOverviewRow({
	threadId,
	status,
	icon,
	title,
	detail,
	age,
	onOpen,
	hint,
}: {
	threadId: string;
	/** The row's tooltip. */
	hint?: string;
	status: string;
	icon: ReactNode;
	title: ReactNode;
	detail: ReactNode;
	age: string | null;
	onOpen: (threadId: string, event: MouseEvent) => void;
}) {
	return (
		<li>
			<button
				type="button"
				className="y-overview-row"
				data-status={status}
				title={hint}
				onClick={(event) => onOpen(threadId, event.nativeEvent)}
			>
				<span className="y-overview-icon">{icon}</span>
				<span className="y-overview-copy">
					<span className="y-overview-title">{title}</span>
					<span className="y-overview-detail">{detail}</span>
				</span>
				{age ? <span className="y-overview-age">{age}</span> : null}
			</button>
		</li>
	);
}

function NeedsYouItem({
	row,
	nowMs,
	onOpen,
}: {
	row: NeedsYouRow;
	nowMs: number;
	onOpen: (threadId: string) => void;
}) {
	const Icon = row.waitingOn === "failed" ? TriangleAlert : CircleAlert;
	return (
		<YOverviewRow
			threadId={row.threadId}
			status="needs-you"
			icon={<Icon size={15} strokeWidth={2} aria-hidden="true" />}
			title={row.title}
			detail={<ThreadId label={row.label}>{row.detail}</ThreadId>}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={(id) => onOpen(id)}
		/>
	);
}

function InProgressItem({
	row,
	nowMs,
	onOpen,
}: {
	row: InProgressRow;
	nowMs: number;
	onOpen: (threadId: string) => void;
}) {
	return (
		<YOverviewRow
			threadId={row.threadId}
			status="in-progress"
			icon={
				<MatrixDotLoader
					className="y-overview-working"
					// The thread's own colour, as on its sidebar row.
					style={
						{
							"--thread-color": threadColor({
								id: row.threadId,
								threadNumber: row.threadNumber,
							}),
						} as CSSProperties
					}
				/>
			}
			title={row.title}
			detail={
				<ThreadId label={row.label}>
					{runningForText(row.workingSince, nowMs)}
				</ThreadId>
			}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={(id) => onOpen(id)}
		/>
	);
}

/** The thread's short label before a row's second line: "WEB-3F9A · running 3m". */
function ThreadId({
	label,
	children,
}: {
	label: string | null;
	children: ReactNode;
}) {
	return label ? (
		<>
			<span className="y-overview-id">{label}</span>
			<span className="y-overview-dot" aria-hidden="true">
				·
			</span>
			{children}
		</>
	) : (
		<>{children}</>
	);
}

function PullRequestItem({
	row,
	nowMs,
	onOpen,
	onOpenPullRequest,
}: {
	row: ThreadPullRequestRow;
	nowMs: number;
	onOpen: (threadId: string) => void;
	onOpenPullRequest?: (row: ThreadPullRequestRow) => void;
}) {
	const Icon = row.draft ? GitPullRequestDraft : GitPullRequest;
	const hasCounts = row.additions !== null || row.deletions !== null;
	return (
		<YOverviewRow
			threadId={row.threadId}
			status={row.draft ? "draft" : "pull-request"}
			hint={`${row.owner}/${row.repo}#${row.number}: opens the pull request here; Ctrl or ⌘ click opens GitHub`}
			icon={<Icon size={15} strokeWidth={2} aria-hidden="true" />}
			title={
				<>
					<span className="y-overview-ref">{row.reference}</span>
					{row.title}
				</>
			}
			detail={
				<>
					<span className="y-overview-branches">
						{row.base ? (
							<>
								{row.base}
								<ArrowLeft
									className="y-overview-arrow"
									size={11}
									strokeWidth={2}
									aria-label="from"
								/>
							</>
						) : null}
						{row.head}
					</span>
					{hasCounts ? (
						<span className="y-overview-diff">
							<span data-diff="added">+{row.additions ?? 0}</span>
							<span data-diff="removed">−{row.deletions ?? 0}</span>
						</span>
					) : null}
					<span className="y-overview-via">
						· via {row.threadLabel ?? row.threadTitle}
					</span>
				</>
			}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={(threadId, event) => {
				if (event.ctrlKey || event.metaKey) {
					window.open(row.url, "_blank", "noopener,noreferrer");
					return;
				}
				if (onOpenPullRequest) onOpenPullRequest(row);
				else onOpen(threadId);
			}}
		/>
	);
}

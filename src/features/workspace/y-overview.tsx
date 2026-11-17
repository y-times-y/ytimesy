import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	ChevronDown,
	CircleAlert,
	GitPullRequest,
	GitPullRequestDraft,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { compactRelativeAge } from "#/domain/sidebar-chats";
import type { RepositoryPullRequest } from "#/domain/sidebar-pr";
import {
	type InProgressRow,
	type NeedsYouRow,
	runningForText,
	type ThreadPullRequestRow,
	yOverview,
} from "#/domain/y-overview";
import { listProjectAgentSessions } from "../sessions/agent-session.fn";

/** How often the open overview reads the project's threads again. */
const LIVE_THREADS_POLL_MS = 15_000;
const CLOCK_TICK_MS = 30_000;

type GroupId = "needs-you" | "in-progress" | "pull-requests";

/**
 * The Y² chat's inspector overview: what needs the person, what is running,
 * and the open pull requests across the project's threads. It shares the
 * sidebar's chat list (same query key) and reads it again while shown.
 */
export function YOverview({
	projectId,
	pullRequests,
	live,
	renderedAtMs,
	onOpenThread,
}: {
	projectId: string;
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
	const overview = yOverview({ chats: chats.data ?? [], pullRequests });
	const empty =
		!overview.needsYou.length &&
		!overview.inProgress.length &&
		!overview.pullRequests.length;

	return (
		<section className="y-overview" aria-label="Project overview">
			{empty ? (
				<p className="y-overview-empty">
					{chats.isPending
						? "Reading threads…"
						: "Nothing needs you. No threads running."}
				</p>
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
}: {
	threadId: string;
	status: string;
	icon: ReactNode;
	title: ReactNode;
	detail: ReactNode;
	age: string | null;
	onOpen: (threadId: string) => void;
}) {
	return (
		<li>
			<button
				type="button"
				className="y-overview-row"
				data-status={status}
				onClick={() => onOpen(threadId)}
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
			detail={row.detail}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={onOpen}
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
			icon={<MatrixDotLoader className="y-overview-working" />}
			title={row.title}
			detail={runningForText(row.workingSince, nowMs)}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={onOpen}
		/>
	);
}

function PullRequestItem({
	row,
	nowMs,
	onOpen,
}: {
	row: ThreadPullRequestRow;
	nowMs: number;
	onOpen: (threadId: string) => void;
}) {
	const Icon = row.draft ? GitPullRequestDraft : GitPullRequest;
	const hasCounts = row.additions !== null || row.deletions !== null;
	return (
		<YOverviewRow
			threadId={row.threadId}
			status={row.draft ? "draft" : "pull-request"}
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
					<span className="y-overview-via">· via {row.threadTitle}</span>
				</>
			}
			age={compactRelativeAge(row.updatedAt, nowMs)}
			onOpen={onOpen}
		/>
	);
}

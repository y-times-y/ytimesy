import { useQuery } from "@tanstack/react-query";
import { CircleAlert, GitPullRequest, TriangleAlert } from "lucide-react";
import { useLayoutEffect, useMemo, useState } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { needsYouDetail, type YOverviewThread } from "#/domain/y-overview";
import {
	type CardThread,
	cardSignature,
	cardTicks,
	elapsedClock,
	type YSquaredCard as YSquaredCardData,
	ySquaredCard,
} from "#/domain/y-squared-card";
import {
	listProjectAgentSessions,
	readYSquaredCrewCard,
} from "../sessions/agent-session.fn";

/**
 * The live status card pinned at the top of the Y² chat: every thread with
 * its status, elapsed time, last request, what it waits on and pull request,
 * needs-you first. It calls no model. The rows are the sidebar's chat list
 * (kept live by the user's hub, the same query), the clock ticks on this
 * client, and the crew's last request / pull request are read once when the
 * rows change (never on a timer).
 */
export function YSquaredCard({
	projectId,
	renderedAtMs,
	onOpenThread,
}: {
	projectId: string;
	renderedAtMs?: number;
	onOpenThread: (threadId: string) => void;
}) {
	const chats = useQuery({
		queryKey: ["agent-sessions", projectId],
		queryFn: () => listProjectAgentSessions({ data: { projectId } }),
		staleTime: 30_000,
	});
	const rows: readonly YOverviewThread[] = chats.data ?? [];
	const signature = cardSignature(rows);
	const crew = useQuery({
		queryKey: ["y-squared-crew-card", projectId, signature],
		queryFn: () => readYSquaredCrewCard({ data: { projectId } }),
		enabled: signature !== "",
		// One read per change of the rows; the previous rows stay until it lands.
		staleTime: Number.POSITIVE_INFINITY,
		placeholderData: (previous) => previous,
	});
	const [nowMs, setNowMs] = useState(() => renderedAtMs ?? Date.now());
	const card = useMemo(
		() => ySquaredCard({ chats: rows, crew: crew.data, now: nowMs }),
		[rows, crew.data, nowMs],
	);
	const ticking = cardTicks(card);
	useLayoutEffect(() => {
		setNowMs(Date.now());
		if (!ticking) return;
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [ticking]);
	if (!card.waiting.length && !card.working.length && !card.done.length)
		return null;
	return (
		<section className="y-card" aria-label="Project status" data-live="true">
			<CardGroup
				label="Waiting on you"
				group="waiting"
				threads={card.waiting}
				nowMs={nowMs}
				onOpen={onOpenThread}
			/>
			<CardGroup
				label="In progress"
				group="working"
				threads={card.working}
				nowMs={nowMs}
				onOpen={onOpenThread}
			/>
			<CardGroup
				label="Done recently"
				group="done"
				threads={card.done}
				nowMs={nowMs}
				onOpen={onOpenThread}
			/>
		</section>
	);
}

function CardGroup({
	label,
	group,
	threads,
	nowMs,
	onOpen,
}: {
	label: string;
	group: keyof YSquaredCardData;
	threads: readonly CardThread[];
	nowMs: number;
	onOpen: (threadId: string) => void;
}) {
	if (!threads.length) return null;
	return (
		<div className="y-card-group" data-group={group}>
			<h3 className="y-card-heading">{label}</h3>
			<ul className="y-card-rows">
				{threads.map((thread) => (
					<CardRow
						key={thread.id}
						thread={thread}
						nowMs={nowMs}
						onOpen={onOpen}
					/>
				))}
			</ul>
		</div>
	);
}

function CardRow({
	thread,
	nowMs,
	onOpen,
}: {
	thread: CardThread;
	nowMs: number;
	onOpen: (threadId: string) => void;
}) {
	const Icon = thread.waitingOn === "failed" ? TriangleAlert : CircleAlert;
	return (
		<li className="y-card-row" data-status={thread.status}>
			<button
				type="button"
				className="y-card-open"
				onClick={() => onOpen(thread.id)}
			>
				<span className="y-card-icon" aria-hidden="true">
					{thread.status === "working" ? (
						<MatrixDotLoader className="y-card-working" />
					) : thread.status === "needs-you" ? (
						<Icon size={14} strokeWidth={2} />
					) : (
						<span className="y-card-done-dot" />
					)}
				</span>
				<span className="y-card-copy">
					<span className="y-card-title">{thread.title}</span>
					{thread.lastRequest ? (
						<span className="y-card-request">{thread.lastRequest}</span>
					) : null}
					{thread.waitingOn ? (
						<span className="y-card-waits">
							{needsYouDetail(thread.waitingOn)}
						</span>
					) : null}
				</span>
				{thread.status === "working" ? (
					<time className="y-card-elapsed">
						{elapsedClock(thread.workingSince, nowMs)}
					</time>
				) : null}
			</button>
			{thread.prUrl ? (
				<a
					className="y-card-pr"
					href={thread.prUrl}
					target="_blank"
					rel="noreferrer"
					aria-label="Open pull request"
				>
					<GitPullRequest size={13} strokeWidth={2} aria-hidden="true" />
				</a>
			) : null}
		</li>
	);
}

import { ChevronRight } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import {
	type AgentPanelRow,
	foldAgentRows,
	LEAD_ROW_ID,
	metricDetail,
	metricText,
} from "#/domain/agent-panel";
import { AgentIcon } from "./agent-icon";
import { useChatRefreshing } from "./chat-refreshing";

/**
 * The chat's agents under the composer, one row each: Main, the helpers of
 * the current request, then background commands. A helper row opens its
 * conversation in the chat view. On narrow screens the list folds behind a
 * summary row.
 */
export function AgentPanel({
	lead,
	helpers,
	background = [],
	selectedId,
	onSelect,
}: {
	lead: AgentPanelRow;
	helpers: readonly AgentPanelRow[];
	background?: readonly AgentPanelRow[];
	selectedId: string;
	onSelect: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showFinished, setShowFinished] = useState(false);
	const refreshing = useChatRefreshing();
	const live = [lead, ...helpers, ...background].some(
		(row) => row.status === "working",
	);
	const now = useNow(live);
	if (helpers.length === 0 && background.length === 0) return null;
	const { shown, folded } = foldAgentRows(helpers);
	// Agents are Main and its helpers. A background command is not one: it is
	// counted on its own, so "3 agents working" never means three shell commands.
	const agents = [lead, ...helpers];
	const working = agents.filter((row) => row.status === "working").length;
	const runningBackground = background.filter(
		(row) => row.status === "working",
	).length;
	const rows = [lead, ...shown, ...(showFinished ? folded : [])];
	return (
		<TooltipPrimitive.Provider delayDuration={200}>
			<section
				className="agent-panel"
				aria-label="Agents"
				data-expanded={expanded ? "true" : undefined}
			>
				<button
					type="button"
					className="agent-panel-summary"
					aria-expanded={expanded}
					onClick={() => {
						setExpanded((open) => !open);
						// Closing the panel returns it to its folded form.
						if (expanded) setShowFinished(false);
					}}
				>
					<span className="agent-panel-icons" aria-hidden="true">
						{agents.slice(0, 5).map((row) => (
							<AgentIcon
								key={row.id}
								icon={row.icon}
								color={
									row.status === "working" || row.id === selectedId
										? row.color
										: RESTING_ICON
								}
								size={12}
							/>
						))}
					</span>
					<span>
						{agents.length} {agents.length === 1 ? "agent" : "agents"}
					</span>
					{refreshing ? (
						<span className="agent-panel-summary-meta">Updating…</span>
					) : working ? (
						<span className="agent-panel-summary-meta">{working} working</span>
					) : null}
					{background.length && !refreshing ? (
						<span className="agent-panel-summary-meta">
							{runningBackground
								? `${runningBackground} background running`
								: `${background.length} background`}
						</span>
					) : null}
					<ChevronRight
						size={14}
						strokeWidth={1.5}
						className="agent-panel-chevron"
						aria-hidden="true"
					/>
				</button>
				<ul className="agent-panel-list">
					{rows.map((row) => (
						<li key={row.id}>
							<AgentRow
								row={row}
								now={now}
								selected={row.id === selectedId}
								onSelect={() => onSelect(row.id)}
							/>
						</li>
					))}
					{folded.length ? (
						<li>
							<button
								type="button"
								className="agent-panel-more"
								aria-expanded={showFinished}
								onClick={() => setShowFinished((shown) => !shown)}
							>
								{showFinished ? "Hide done" : `+${folded.length} done`}
							</button>
						</li>
					) : null}
					{background.map((row) => (
						<li key={row.id}>
							<AgentRow row={row} now={now} selected={false} />
						</li>
					))}
					{/* On a phone the list opens from the summary above it: this is the way
					    back to the folded form without scrolling up to it. */}
					<li className="agent-panel-collapse-item">
						<button
							type="button"
							className="agent-panel-more agent-panel-collapse"
							onClick={() => {
								setExpanded(false);
								setShowFinished(false);
							}}
						>
							Show less
						</button>
					</li>
				</ul>
			</section>
		</TooltipPrimitive.Provider>
	);
}

/** A clock that ticks each second while something runs. */
function useNow(live: boolean) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		if (!live) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [live]);
	return now;
}

/** A resting agent's icon: dim, so the working and the open one stand out. */
const RESTING_ICON = "#6d6d6d";

function AgentRow({
	row,
	now,
	selected,
	onSelect,
}: {
	row: AgentPanelRow;
	now: number;
	selected: boolean;
	onSelect?: () => void;
}) {
	const detail = row.metric ? metricDetail(row.metric) : null;
	const content = (
		<>
			{/* Its status dot: bright while it works or is open, dim otherwise. */}
			<AgentIcon
				icon={row.icon}
				color={row.status === "working" || selected ? row.color : RESTING_ICON}
			/>
			<span className="agent-row-name" title={row.title || row.name}>
				{row.name}
			</span>
			{row.task ? (
				<span className="agent-row-task" title={row.title}>
					{row.task}
				</span>
			) : null}
			{row.tag ? <span className="agent-row-tag">{row.tag}</span> : null}
			{/* Keyed on the line: a new activity fades in instead of flickering. */}
			<span
				key={row.doing}
				className="agent-row-doing"
				title={row.doingDetail ?? row.doing}
			>
				{row.doing}
			</span>
			{row.queued ? (
				<span className="agent-row-queued">{row.queued} queued</span>
			) : null}
			{row.metric && metricText(row.metric, now) ? (
				detail ? (
					<TooltipPrimitive.Root>
						<TooltipPrimitive.Trigger asChild>
							<span className="agent-row-metric">
								{metricText(row.metric, now)}
							</span>
						</TooltipPrimitive.Trigger>
						<TooltipPrimitive.Portal>
							<TooltipPrimitive.Content
								className="agent-metric-tooltip"
								side="top"
								sideOffset={6}
							>
								{detail}
							</TooltipPrimitive.Content>
						</TooltipPrimitive.Portal>
					</TooltipPrimitive.Root>
				) : (
					<span className="agent-row-metric">
						{metricText(row.metric, now)}
					</span>
				)
			) : null}
		</>
	);
	if (!onSelect)
		return (
			<div className="agent-row" data-kind={row.kind} data-status={row.status}>
				{content}
			</div>
		);
	return (
		<button
			type="button"
			className="agent-row"
			data-kind={row.kind}
			data-status={row.status}
			aria-current={selected ? "true" : undefined}
			title={row.id === LEAD_ROW_ID ? "Back to the chat" : undefined}
			onClick={onSelect}
		>
			{content}
		</button>
	);
}

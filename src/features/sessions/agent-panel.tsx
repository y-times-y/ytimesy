import { ChevronRight } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type CSSProperties, useEffect, useState } from "react";
import {
	type AgentPanelRow,
	foldAgentRows,
	LEAD_ROW_ID,
	metricDetail,
	metricText,
} from "#/domain/agent-panel";
import { AgentIcon } from "./agent-icon";

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
	const live = [lead, ...helpers, ...background].some(
		(row) => row.status === "working",
	);
	const now = useNow(live);
	if (helpers.length === 0 && background.length === 0) return null;
	const { shown, folded } = foldAgentRows(helpers);
	const all = [lead, ...helpers, ...background];
	const working = all.filter((row) => row.status === "working").length;
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
					onClick={() => setExpanded((open) => !open)}
				>
					<span className="agent-panel-icons" aria-hidden="true">
						{all.slice(0, 5).map((row) => (
							<AgentIcon
								key={row.id}
								icon={row.icon}
								color={row.color}
								size={12}
							/>
						))}
					</span>
					<span>{all.length} agents</span>
					{working ? (
						<span className="agent-panel-summary-meta">{working} working</span>
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
					{folded.length && !showFinished ? (
						<li>
							<button
								type="button"
								className="agent-panel-more"
								onClick={() => setShowFinished(true)}
							>
								+{folded.length} done
							</button>
						</li>
					) : null}
					{background.map((row) => (
						<li key={row.id}>
							<AgentRow row={row} now={now} selected={false} />
						</li>
					))}
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
			<AgentIcon icon={row.icon} color={row.color} />
			<span className="agent-row-name" title={row.title || row.name}>
				{row.name}
			</span>
			{row.tag ? <span className="agent-row-tag">{row.tag}</span> : null}
			{/* Keyed on the line: a new activity fades in instead of flickering. */}
			<span key={row.doing} className="agent-row-doing" title={row.doing}>
				{row.doing}
			</span>
			{row.queued ? (
				<span className="agent-row-queued">{row.queued} queued</span>
			) : null}
			<span className="agent-row-status" data-status={row.status}>
				{row.statusLabel}
			</span>
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
			style={{ "--agent-accent": row.color } as CSSProperties}
			title={row.id === LEAD_ROW_ID ? "Back to the chat" : undefined}
			onClick={onSelect}
		>
			{content}
		</button>
	);
}

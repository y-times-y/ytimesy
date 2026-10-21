import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
	type AgentPanelRow,
	foldAgentRows,
	LEAD_ROW_ID,
} from "#/domain/agent-panel";

const STATUS_LABEL: Record<AgentPanelRow["status"], string> = {
	working: "working",
	done: "done",
	failed: "failed",
	idle: "idle",
};

/**
 * The chat's agents under the composer, one row each: the lead, then the
 * helpers of the current request. A row opens that agent's conversation in
 * the chat view. On narrow screens the list folds behind a summary row.
 */
export function AgentPanel({
	lead,
	helpers,
	selectedId,
	onSelect,
}: {
	lead: AgentPanelRow;
	helpers: readonly AgentPanelRow[];
	selectedId: string;
	onSelect: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showFinished, setShowFinished] = useState(false);
	if (helpers.length === 0) return null;
	const { shown, folded } = foldAgentRows(helpers);
	const working = [lead, ...helpers].filter(
		(row) => row.status === "working",
	).length;
	const rows = [lead, ...shown, ...(showFinished ? folded : [])];
	return (
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
				<span className="agent-panel-dots" aria-hidden="true">
					{[lead, ...helpers].slice(0, 5).map((row) => (
						<span key={row.id} className="agent-dot" data-color={row.color} />
					))}
				</span>
				<span>{helpers.length + 1} agents</span>
				{working ? (
					<span className="agent-panel-summary-meta">{working} working</span>
				) : null}
				<ChevronRight
					size={13}
					className="agent-panel-chevron"
					aria-hidden="true"
				/>
			</button>
			<ul className="agent-panel-list">
				{rows.map((row) => (
					<li key={row.id}>
						<AgentRow
							row={row}
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
			</ul>
		</section>
	);
}

function AgentRow({
	row,
	selected,
	onSelect,
}: {
	row: AgentPanelRow;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className="agent-row"
			data-status={row.status}
			aria-current={selected ? "true" : undefined}
			title={row.id === LEAD_ROW_ID ? "Back to the chat" : `Open ${row.name}`}
			onClick={onSelect}
		>
			<span className="agent-dot" data-color={row.color} aria-hidden="true" />
			<span className="agent-row-name">{row.name}</span>
			{/* Keyed on the line: a new activity fades in instead of flickering. */}
			<span key={row.doing} className="agent-row-doing" title={row.doing}>
				{row.doing}
			</span>
			{row.queued ? (
				<span className="agent-row-queued">{row.queued} queued</span>
			) : null}
			<span className="agent-row-status" data-status={row.status}>
				{STATUS_LABEL[row.status]}
			</span>
		</button>
	);
}

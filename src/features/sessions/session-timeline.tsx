import { ChevronRight } from "lucide-react";
import { type UIEvent, useEffect, useRef } from "react";
import { fileChangeTotals } from "#/domain/diff-preview";
import { fileChangeActivity } from "#/domain/file-change-copy";
import { activityGlyphForToolName } from "#/domain/session-activity";
import {
	compactTimelineItems,
	type SessionItem,
	type SessionTurnStatus,
	showTurnWorking,
} from "#/domain/session-item";
import { thoughtLabel } from "#/domain/thought-label";
import {
	explorationLabel,
	groupTimelineRows,
	type TimelineRow,
} from "#/domain/timeline-activity";
import { visibleShellCommand } from "#/domain/visible-shell-command";
import { ActivityIcon } from "./activity-icon";
import { AgentMarkdown } from "./agent-markdown";
import { FileChangeCounts } from "./file-change-counts";

export function SessionTimeline({
	items,
	turnStatus,
	fill = false,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	fill?: boolean;
}) {
	const listRef = useRef<HTMLOListElement>(null);
	const stickToEnd = useRef(true);
	const visible = compactTimelineItems(items);
	const rows = groupTimelineRows(visible);

	useEffect(() => {
		if (!stickToEnd.current) return;
		if (items.length === 0 && turnStatus !== "running") return;
		listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
	}, [items, turnStatus]);

	function rememberScrollPin(event: UIEvent<HTMLOListElement>) {
		const list = event.currentTarget;
		stickToEnd.current =
			list.scrollHeight - list.scrollTop - list.clientHeight < 64;
	}

	if (items.length === 0 && turnStatus !== "running" && !fill) return null;

	return (
		<ol
			ref={listRef}
			className="session-timeline"
			aria-label="Session"
			onScroll={rememberScrollPin}
		>
			{rows.map((row) => (
				<li
					key={row.kind === "item" ? row.item.id : `explore:${row.id}`}
					data-kind={row.kind === "item" ? row.item.kind : "exploration"}
				>
					<TimelineRowView
						row={row}
						turnRunning={turnStatus === "running"}
						isLastItem={
							row.kind === "item" && row.item.id === visible.at(-1)?.id
						}
					/>
				</li>
			))}
			{showTurnWorking(items, turnStatus) ? (
				<li data-kind="working">
					<p className="session-working">Thinking</p>
				</li>
			) : null}
		</ol>
	);
}

function TimelineRowView({
	row,
	turnRunning,
	isLastItem,
}: {
	row: TimelineRow;
	turnRunning: boolean;
	isLastItem: boolean;
}) {
	if (row.kind === "exploration") {
		return (
			<details className="session-exploration">
				<summary>
					<span className="session-activity-title">
						{explorationLabel(row.counts)}
					</span>
					<ChevronRight size={12} className="session-activity-chevron" />
				</summary>
				{row.items.map((item) => (
					<SessionItemView key={item.id} item={item} nested />
				))}
			</details>
		);
	}
	return (
		<SessionItemView
			item={row.item}
			thoughtInProgress={turnRunning && isLastItem}
		/>
	);
}

function SessionItemView({
	item,
	nested = false,
	thoughtInProgress = false,
}: {
	item: SessionItem;
	nested?: boolean;
	thoughtInProgress?: boolean;
}) {
	switch (item.kind) {
		case "userMessage":
			return (
				<div className="session-message" data-role="user">
					<p>{item.text}</p>
				</div>
			);
		case "agentMessage":
			return (
				<div className="session-message" data-role="assistant">
					<AgentMarkdown text={item.text} />
				</div>
			);
		case "reasoning": {
			const summaries = item.summaries.filter((summary) => summary.trim());
			const title = thoughtLabel({
				durationSeconds: item.durationSeconds,
				inProgress: thoughtInProgress && item.durationSeconds == null,
			});
			if (summaries.length === 0) {
				return (
					<div className="session-activity" data-kind="reasoning">
						<p>
							<span className="session-activity-title">{title}</span>
						</p>
					</div>
				);
			}
			return (
				<details className="session-activity" data-kind="reasoning">
					<summary>
						<span className="session-activity-title">{title}</span>
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					{summaries.map((summary) => (
						<p key={`${item.id}:${summary}`}>{summary}</p>
					))}
				</details>
			);
		}
		case "plan":
			return (
				<details className="session-activity" data-kind="plan">
					<summary>
						<ActivityIcon glyph="plan" />
						<span className="session-activity-title">Plan</span>
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					<p>{item.text || "Planning…"}</p>
				</details>
			);
		case "commandExecution": {
			const status = activityStatusLabel(item.status);
			return (
				<details
					className="session-activity"
					data-kind="commandExecution"
					data-status={item.status}
					open={item.status === "inProgress"}
				>
					<summary>
						<span className="session-shell-prefix" aria-hidden="true">
							$
						</span>
						<code className="session-activity-title">
							{visibleShellCommand(item.command)}
						</code>
						{item.status === "inProgress" ? (
							<span className="session-activity-spinner" aria-hidden="true" />
						) : status ? (
							<span className="session-activity-status">{status}</span>
						) : null}
					</summary>
					{item.output ? (
						<pre className="session-output">{item.output}</pre>
					) : null}
					{item.status === "failed" && item.exitCode !== null ? (
						<p className="session-activity-meta">exit {item.exitCode}</p>
					) : null}
				</details>
			);
		}
		case "fileChange": {
			const totals = fileChangeTotals(item.changes);
			const activity = fileChangeActivity(item.changes);
			const status = activityStatusLabel(item.status);
			return (
				<div
					className="session-activity"
					data-kind="fileChange"
					data-status={item.status}
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph="edit" />
						<span className="session-activity-title">
							{activity.verb}{" "}
							{activity.name ? (
								<span className="session-file-name">{activity.name}</span>
							) : (
								`${item.changes.length} files`
							)}
						</span>
						<FileChangeCounts
							additions={totals.additions}
							deletions={totals.deletions}
						/>
						{item.status === "inProgress" ? (
							<span className="session-activity-spinner" aria-hidden="true" />
						) : status ? (
							<span className="session-activity-status">{status}</span>
						) : null}
					</p>
				</div>
			);
		}
		case "mcpToolCall":
			return (
				<div
					className="session-activity"
					data-kind="mcpToolCall"
					data-status={item.status}
				>
					<p>
						<ActivityIcon glyph="mcp" />
						<span className="session-activity-title">
							{item.server} · {item.tool}
						</span>
						{activityStatus(item.status)}
					</p>
				</div>
			);
		case "dynamicToolCall":
			return (
				<div
					className="session-activity"
					data-kind="dynamicToolCall"
					data-status={item.status}
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph={activityGlyphForToolName(item.tool)} />
						<span className="session-activity-title">{item.tool}</span>
						{activityStatus(item.status)}
					</p>
				</div>
			);
		case "webSearch":
			return (
				<div
					className="session-activity"
					data-kind="webSearch"
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph="web" />
						<span className="session-activity-title">
							{item.query ? item.query : "Search"}
						</span>
					</p>
				</div>
			);
		case "error":
			return (
				<div className="session-activity" data-kind="error" role="alert">
					<p>
						<ActivityIcon glyph="error" />
						<span className="session-activity-title">{item.message}</span>
					</p>
				</div>
			);
		case "unknown":
			return (
				<div
					className="session-activity"
					data-kind="unknown"
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph={activityGlyphForToolName(item.type)} />
						<span className="session-activity-title">{item.type}</span>
					</p>
				</div>
			);
	}
}

function activityStatus(status: string) {
	if (status === "inProgress") {
		return <span className="session-activity-spinner" aria-hidden="true" />;
	}
	const label = activityStatusLabel(status);
	return label ? (
		<span className="session-activity-status">{label}</span>
	) : null;
}

function activityStatusLabel(status: string): string | null {
	if (status === "failed") return "Failed";
	if (status === "declined") return "Declined";
	return null;
}

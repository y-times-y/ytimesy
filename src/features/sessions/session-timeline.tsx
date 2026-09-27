import { ChevronRight } from "lucide-react";
import { type UIEvent, useEffect, useRef } from "react";
import { commandActivityTitle } from "#/domain/command-activity-title";
import { fileChangeTotals } from "#/domain/diff-preview";
import {
	fileChangeActivity,
	fileChangeActivityTitle,
} from "#/domain/file-change-copy";
import { fileBasename } from "#/domain/file-kind";
import { activityGlyphForToolName } from "#/domain/session-activity";
import {
	compactTimelineItems,
	type FileChangeEntry,
	fileChangesFromSessionItems,
	liveActivityStatus,
	type SessionItem,
	type SessionTurnStatus,
	showTurnWorking,
} from "#/domain/session-item";
import { thoughtLabel } from "#/domain/thought-label";
import {
	explorationGroupIsLive,
	explorationLabel,
	groupExplorationRows,
	groupTimelineRows,
	type TimelineRow,
} from "#/domain/timeline-activity";
import { ActivityIcon } from "./activity-icon";
import { AgentMarkdown } from "./agent-markdown";
import { FileChangeCounts } from "./file-change-counts";
import { FileMentionButton } from "./file-mention";
import { LiveCollapsible } from "./live-collapsible";
import { ShellCommandCode } from "./shell-command-code";

export function SessionTimeline({
	items,
	turnStatus,
	fill = false,
	onOpenFile,
}: {
	items: readonly SessionItem[];
	turnStatus: SessionTurnStatus;
	fill?: boolean;
	onOpenFile?: (path: string) => void;
}) {
	const listRef = useRef<HTMLOListElement>(null);
	const stickToEnd = useRef(true);
	const visible = compactTimelineItems(items);
	const rows = groupTimelineRows(visible, turnStatus);
	const fileChanges = fileChangesFromSessionItems(items);
	const currentTurnIds = new Set<SessionItem["id"]>();
	for (const item of visible) {
		if (item.kind === "userMessage") currentTurnIds.clear();
		else currentTurnIds.add(item.id);
	}

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
					key={row.kind === "item" ? row.item.id : `${row.kind}:${row.id}`}
					data-kind={row.kind === "item" ? row.item.kind : row.kind}
				>
					<TimelineRowView
						row={row}
						turnRunning={
							turnStatus === "running" &&
							currentTurnIds.has(row.kind === "item" ? row.item.id : row.id)
						}
						isLastItem={
							(row.kind === "item" ? row.item.id : row.items.at(-1)?.id) ===
							visible.at(-1)?.id
						}
						fileChanges={fileChanges}
						onOpenFile={onOpenFile}
					/>
				</li>
			))}
			{showTurnWorking(items, turnStatus) ? (
				<li data-kind="working">
					<p className="session-working session-shimmer">Thinking</p>
				</li>
			) : null}
		</ol>
	);
}

function TimelineRowView({
	row,
	turnRunning,
	isLastItem,
	fileChanges,
	onOpenFile,
}: {
	row: TimelineRow;
	turnRunning: boolean;
	isLastItem: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	if (row.kind === "work") {
		return (
			<details className="session-work">
				<summary>
					<span title="Elapsed time from dispatch to observed completion">
						{row.label}
					</span>
					<ChevronRight size={12} className="session-activity-chevron" />
				</summary>
				<div className="session-work-items">
					{groupExplorationRows(row.items).map((child) => (
						<TimelineRowView
							key={child.kind === "item" ? child.item.id : child.id}
							row={child}
							turnRunning={false}
							isLastItem={false}
							fileChanges={fileChanges}
							onOpenFile={onOpenFile}
						/>
					))}
				</div>
			</details>
		);
	}
	if (row.kind === "exploration") {
		const live = turnRunning && explorationGroupIsLive(row.items);
		return (
			<LiveCollapsible
				className="session-exploration"
				data-live={live ? "true" : undefined}
				live={live}
			>
				<summary>
					<span
						className={
							live
								? "session-activity-title session-shimmer"
								: "session-activity-title"
						}
					>
						{explorationLabel(row.counts)}
					</span>
					<ChevronRight size={12} className="session-activity-chevron" />
				</summary>
				{row.items.map((item) => (
					<SessionItemView
						key={item.id}
						item={item}
						nested
						turnRunning={turnRunning}
						fileChanges={fileChanges}
						onOpenFile={onOpenFile}
					/>
				))}
			</LiveCollapsible>
		);
	}
	return (
		<SessionItemView
			item={row.item}
			thoughtInProgress={turnRunning && isLastItem}
			turnRunning={turnRunning}
			fileChanges={fileChanges}
			onOpenFile={onOpenFile}
		/>
	);
}

function SessionItemView({
	item,
	nested = false,
	thoughtInProgress = false,
	turnRunning = false,
	fileChanges,
	onOpenFile,
}: {
	item: SessionItem;
	nested?: boolean;
	thoughtInProgress?: boolean;
	turnRunning?: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	const live = activityTitleIsLive(item, turnRunning, thoughtInProgress);
	const titleClass = live
		? "session-activity-title session-shimmer"
		: "session-activity-title";
	switch (item.kind) {
		case "userMessage":
			return (
				<div className="session-message" data-role="user">
					<p>{item.text}</p>
				</div>
			);
		case "agentMessage":
			return (
				<div
					className="session-message"
					data-role="assistant"
					data-streaming={turnRunning && item.streaming ? "true" : undefined}
				>
					<AgentMarkdown
						text={item.text}
						streaming={Boolean(turnRunning && item.streaming)}
						fileChanges={fileChanges}
						onOpenFile={onOpenFile}
					/>
				</div>
			);
		case "reasoning": {
			const summaries = item.summaries.filter((summary) => summary.trim());
			const title = thoughtLabel({
				durationSeconds: item.durationSeconds,
				inProgress: live,
			});
			if (summaries.length === 0) {
				if (!live) return null;
				return (
					<div
						className="session-activity"
						data-kind="reasoning"
						data-live={live ? "true" : undefined}
					>
						<p>
							<span className={titleClass}>{title}</span>
						</p>
					</div>
				);
			}
			return (
				<LiveCollapsible
					className="session-activity"
					data-kind="reasoning"
					data-live={live ? "true" : undefined}
					live={live}
				>
					<summary>
						<span className={titleClass}>
							{summaries[0]?.split("\n")[0].replace(/^#+\s*|\*\*/g, "") ||
								title}
						</span>
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					{summaries.map((summary) => (
						<p key={`${item.id}:${summary}`}>{summary}</p>
					))}
				</LiveCollapsible>
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
					data-live={live ? "true" : undefined}
				>
					<summary>
						<span className={titleClass}>
							{commandActivityTitle(item.command)}
						</span>
						{status ? (
							<span className="session-activity-status">{status}</span>
						) : null}
						<ChevronRight size={12} className="session-activity-chevron" />
					</summary>
					<div className="session-command-detail">
						<ShellCommandCode command={item.command} />
						{item.output ? (
							<pre className="session-output">{item.output}</pre>
						) : null}
						{item.exitCode !== null ? (
							<p className="session-activity-meta">exit {item.exitCode}</p>
						) : null}
					</div>
				</details>
			);
		}
		case "fileChange": {
			const totals = fileChangeTotals(item.changes);
			const title = fileChangeActivityTitle(item.changes);
			const status = activityStatusLabel(item.status);
			const counts = (
				<FileChangeCounts
					additions={totals.additions}
					deletions={totals.deletions}
				/>
			);
			const progress = status ? (
				<span className="session-activity-status">{status}</span>
			) : null;
			if (item.changes.length === 0) return null;
			if (item.changes.length === 1) {
				const activity = fileChangeActivity(item.changes);
				const change = item.changes[0];
				return (
					<div
						className="session-activity"
						data-kind="fileChange"
						data-status={item.status}
						data-live={live ? "true" : undefined}
						data-nested={nested ? "true" : undefined}
					>
						<p>
							<ActivityIcon glyph="edit" />
							<span className={titleClass}>
								{activity.verb}{" "}
								{change && activity.name ? (
									<FileMentionButton
										path={change.path}
										name={activity.name}
										change={change.change}
										onOpenFile={onOpenFile}
									/>
								) : (
									"1 file"
								)}
							</span>
							{counts}
							{progress}
						</p>
					</div>
				);
			}
			return (
				<details
					className="session-activity"
					data-kind="fileChange"
					data-status={item.status}
					data-live={live ? "true" : undefined}
					data-nested={nested ? "true" : undefined}
					open
				>
					<summary>
						<ActivityIcon glyph="edit" />
						<span className={titleClass}>{title}</span>
						{counts}
						<ChevronRight size={12} className="session-activity-chevron" />
						{progress}
					</summary>
					{item.changes.map((change) => (
						<p className="session-file-change-row" key={change.path}>
							<FileMentionButton
								path={change.path}
								name={fileBasename(change.path)}
								change={change.change}
								onOpenFile={onOpenFile}
							/>
							<FileChangeCounts
								additions={change.additions}
								deletions={change.deletions}
							/>
						</p>
					))}
				</details>
			);
		}
		case "mcpToolCall":
			return (
				<div
					className="session-activity"
					data-kind="mcpToolCall"
					data-status={item.status}
					data-live={live ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph="mcp" />
						<span className={titleClass}>
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
					data-live={live ? "true" : undefined}
					data-nested={nested ? "true" : undefined}
				>
					<p>
						<ActivityIcon glyph={activityGlyphForToolName(item.tool)} />
						<span className={titleClass}>{item.tool}</span>
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
	const label = activityStatusLabel(status);
	return label ? (
		<span className="session-activity-status">{label}</span>
	) : null;
}

function activityTitleIsLive(
	item: SessionItem,
	turnRunning: boolean,
	thoughtInProgress: boolean,
): boolean {
	if (item.kind === "reasoning") {
		return turnRunning && thoughtInProgress;
	}
	return turnRunning && liveActivityStatus(item) === "inProgress";
}

function activityStatusLabel(status: string): string | null {
	if (status === "failed") return "Failed";
	if (status === "declined") return "Declined";
	return null;
}

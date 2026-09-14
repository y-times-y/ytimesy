import { useEffect, useRef } from "react";
import { fileChangeTotals } from "#/domain/diff-preview";
import { fileChangeActivityTitle } from "#/domain/file-change-copy";
import { activityGlyphForToolName } from "#/domain/session-activity";
import type { SessionItem, SessionTurnStatus } from "#/domain/session-item";
import { visibleShellCommand } from "#/domain/visible-shell-command";
import { ActivityIcon } from "./activity-icon";
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

	useEffect(() => {
		listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
	});

	if (items.length === 0 && turnStatus !== "running" && !fill) return null;

	return (
		<ol ref={listRef} className="session-timeline" aria-label="Session">
			{items.map((item) => (
				<li key={item.id} data-kind={item.kind}>
					<SessionItemView item={item} />
				</li>
			))}
			{turnStatus === "running" ? (
				<li data-kind="working">
					<p className="session-working">Working…</p>
				</li>
			) : null}
		</ol>
	);
}

function SessionItemView({ item }: { item: SessionItem }) {
	switch (item.kind) {
		case "userMessage":
			return <ConversationBlock text={item.text} speaker="user" />;
		case "agentMessage":
			return <ConversationBlock text={item.text} speaker="assistant" />;
		case "reasoning": {
			const summaries = item.summaries.filter((summary) => summary.trim());
			if (summaries.length === 0) {
				return (
					<div className="session-activity" data-kind="reasoning">
						<p>
							<ActivityIcon glyph="thinking" />
							<span className="session-activity-title">Thinking</span>
						</p>
					</div>
				);
			}
			return (
				<details className="session-activity" data-kind="reasoning">
					<summary>
						<ActivityIcon glyph="thinking" />
						<span className="session-activity-title">Thinking</span>
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
						<ActivityIcon glyph="shell" />
						<code className="session-activity-title">
							{visibleShellCommand(item.command)}
						</code>
						{status ? (
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
			const status = activityStatusLabel(item.status);
			return (
				<div
					className="session-activity"
					data-kind="fileChange"
					data-status={item.status}
				>
					<p>
						<ActivityIcon glyph="edit" />
						<span className="session-activity-title">
							{fileChangeActivityTitle(item.changes)}
						</span>
						<FileChangeCounts
							additions={totals.additions}
							deletions={totals.deletions}
						/>
						{status ? (
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
				<div className="session-activity" data-kind="webSearch">
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
				<div className="session-activity" data-kind="unknown">
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

function ConversationBlock({
	text,
	speaker,
}: {
	text: string;
	speaker: "user" | "assistant";
}) {
	return (
		<div className="session-message" data-role={speaker}>
			<p>{text}</p>
		</div>
	);
}

function activityStatusLabel(status: string): string | null {
	if (status === "inProgress") return "Running";
	if (status === "failed") return "Failed";
	if (status === "declined") return "Declined";
	return null;
}
